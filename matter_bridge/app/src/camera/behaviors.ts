/**
 * Matter 1.5 camera clusters backed by a camera stream:
 *
 *  - CameraAvStreamManagement: stream allocation (video H.264, audio Opus) and JPEG snapshots
 *  - WebRtcTransportProvider: WebRTC signaling; the SDP answer/offer is delivered back to the controller by
 *    invoking the WebRtcTransportRequestor cluster on the controller's node
 */
import { type Endpoint, ServerNode } from "@matter/main";
import { CameraAvStreamManagementServer, WebRtcTransportProviderServer } from "@matter/main/behaviors";
import {
    CameraAvStreamManagement,
    WebRtcTransportDefinitions,
    WebRtcTransportProvider,
    WebRtcTransportRequestor,
} from "@matter/main/clusters";
import { Invoke, type PeerAddress } from "@matter/main/protocol";
import { EndpointNumber, Status, StatusResponseError, StreamUsage } from "@matter/main/types";
import { log } from "../log.js";
import { contextOf } from "../matter/context.js";
import { jpegSize } from "./jpeg.js";
import type { CameraSource } from "./source.js";
import { CameraWebRtcSession, type IceServerConfig } from "./webrtc.js";

const { VideoCodec, AudioCodec, ImageCodec } = CameraAvStreamManagement;
const EndReason = WebRtcTransportDefinitions.WebRtcEndReason;

/** Runtime data of a camera endpoint that must not live in Matter state */
interface CameraRuntime {
    nextSessionId: number;
    sessions: Map<number, { session: CameraWebRtcSession; peer: PeerAddress; peerEndpoint: number }>;
}

const runtimes = new Map<string, CameraRuntime>();

function runtimeOf(endpoint: Endpoint): CameraRuntime {
    let runtime = runtimes.get(endpoint.id);
    if (!runtime) {
        runtime = { nextSessionId: 1, sessions: new Map() };
        runtimes.set(endpoint.id, runtime);
    }
    return runtime;
}

/** Closes all WebRTC sessions of a camera endpoint (when it is removed from the bridge) */
export function closeCameraSessions(endpointId: string) {
    const runtime = runtimes.get(endpointId);
    if (!runtime) return;
    for (const { session } of runtime.sessions.values()) session.close();
    runtimes.delete(endpointId);
}

function sourceOf(endpoint: Endpoint): CameraSource {
    const source = contextOf(endpoint).camera;
    if (!source) throw new StatusResponseError("Camera stream not configured", Status.Failure);
    return source;
}

const notFound = (what: string) => new StatusResponseError(`${what} not found`, Status.NotFound);

// -------------------------------------------------------------------------------------------------------------
// Stream management
// -------------------------------------------------------------------------------------------------------------

const CameraAvBase = CameraAvStreamManagementServer.with("Video", "Audio", "Snapshot");

export class HaCameraAvStreamManagementServer extends CameraAvBase {
    override initialize() {
        // Sessions do not survive a restart
        const reset = <T extends { referenceCount: number }>(list: T[]) => list.map(s => ({ ...s, referenceCount: 0 }));
        this.state.allocatedVideoStreams = reset(this.state.allocatedVideoStreams);
        this.state.allocatedAudioStreams = reset(this.state.allocatedAudioStreams);
        this.state.allocatedSnapshotStreams = reset(this.state.allocatedSnapshotStreams);
    }

    #nextId(list: Array<{ [key: string]: unknown }>, key: string) {
        let id = 1;
        while (list.some(e => e[key] === id)) id++;
        return id;
    }

    override setStreamPriorities({ streamPriorities }: CameraAvStreamManagement.SetStreamPrioritiesRequest) {
        const supported = this.state.supportedStreamUsages;
        if (streamPriorities.some(usage => !supported.includes(usage))) {
            throw new StatusResponseError("Unsupported stream usage", Status.DynamicConstraintError);
        }
        this.state.streamUsagePriorities = [...streamPriorities];
    }

    override videoStreamAllocate(request: CameraAvStreamManagement.VideoStreamAllocateRequest) {
        if (!this.state.supportedStreamUsages.includes(request.streamUsage)) {
            throw new StatusResponseError("Unsupported stream usage", Status.InvalidInState);
        }
        if (request.videoCodec !== VideoCodec.H264) {
            throw new StatusResponseError("Only H.264 is supported", Status.DynamicConstraintError);
        }
        // Reuse an existing stream with the same usage - the bridge only has one encoder
        const existing = this.state.allocatedVideoStreams.find(s => s.streamUsage === request.streamUsage);
        if (existing) return { videoStreamId: existing.videoStreamId };

        const videoStreamId = this.#nextId(this.state.allocatedVideoStreams as any, "videoStreamId");
        this.state.allocatedVideoStreams = [
            ...this.state.allocatedVideoStreams,
            {
                videoStreamId,
                streamUsage: request.streamUsage,
                videoCodec: request.videoCodec,
                minFrameRate: request.minFrameRate,
                maxFrameRate: request.maxFrameRate,
                minResolution: request.minResolution,
                maxResolution: request.maxResolution,
                minBitRate: request.minBitRate,
                maxBitRate: request.maxBitRate,
                keyFrameInterval: request.keyFrameInterval,
                referenceCount: 0,
            },
        ];
        return { videoStreamId };
    }

    override videoStreamDeallocate({ videoStreamId }: CameraAvStreamManagement.VideoStreamDeallocateRequest) {
        const stream = this.state.allocatedVideoStreams.find(s => s.videoStreamId === videoStreamId);
        if (!stream) throw notFound("Video stream");
        if (stream.referenceCount > 0) throw new StatusResponseError("Stream in use", Status.InvalidInState);
        this.state.allocatedVideoStreams = this.state.allocatedVideoStreams.filter(s => s.videoStreamId !== videoStreamId);
    }

    override audioStreamAllocate(request: CameraAvStreamManagement.AudioStreamAllocateRequest) {
        if (!this.state.supportedStreamUsages.includes(request.streamUsage)) {
            throw new StatusResponseError("Unsupported stream usage", Status.InvalidInState);
        }
        if (request.audioCodec !== AudioCodec.Opus) {
            throw new StatusResponseError("Only Opus is supported", Status.DynamicConstraintError);
        }
        const existing = this.state.allocatedAudioStreams.find(s => s.streamUsage === request.streamUsage);
        if (existing) return { audioStreamId: existing.audioStreamId };

        const audioStreamId = this.#nextId(this.state.allocatedAudioStreams as any, "audioStreamId");
        this.state.allocatedAudioStreams = [
            ...this.state.allocatedAudioStreams,
            {
                audioStreamId,
                streamUsage: request.streamUsage,
                audioCodec: request.audioCodec,
                channelCount: request.channelCount,
                sampleRate: request.sampleRate,
                bitRate: request.bitRate,
                bitDepth: request.bitDepth,
                referenceCount: 0,
            },
        ];
        return { audioStreamId };
    }

    override audioStreamDeallocate({ audioStreamId }: CameraAvStreamManagement.AudioStreamDeallocateRequest) {
        const stream = this.state.allocatedAudioStreams.find(s => s.audioStreamId === audioStreamId);
        if (!stream) throw notFound("Audio stream");
        if (stream.referenceCount > 0) throw new StatusResponseError("Stream in use", Status.InvalidInState);
        this.state.allocatedAudioStreams = this.state.allocatedAudioStreams.filter(s => s.audioStreamId !== audioStreamId);
    }

    override snapshotStreamAllocate(request: CameraAvStreamManagement.SnapshotStreamAllocateRequest) {
        if (request.imageCodec !== ImageCodec.Jpeg) {
            throw new StatusResponseError("Only JPEG is supported", Status.DynamicConstraintError);
        }
        const snapshotStreamId = this.#nextId(this.state.allocatedSnapshotStreams as any, "snapshotStreamId");
        this.state.allocatedSnapshotStreams = [
            ...this.state.allocatedSnapshotStreams,
            {
                snapshotStreamId,
                imageCodec: request.imageCodec,
                frameRate: request.maxFrameRate,
                minResolution: request.minResolution,
                maxResolution: request.maxResolution,
                quality: request.quality,
                referenceCount: 0,
                encodedPixels: false,
                hardwareEncoder: false,
            },
        ];
        return { snapshotStreamId };
    }

    override snapshotStreamDeallocate({ snapshotStreamId }: CameraAvStreamManagement.SnapshotStreamDeallocateRequest) {
        if (!this.state.allocatedSnapshotStreams.some(s => s.snapshotStreamId === snapshotStreamId)) {
            throw notFound("Snapshot stream");
        }
        this.state.allocatedSnapshotStreams = this.state.allocatedSnapshotStreams.filter(
            s => s.snapshotStreamId !== snapshotStreamId,
        );
    }

    override async captureSnapshot({ snapshotStreamId, requestedResolution }: CameraAvStreamManagement.CaptureSnapshotRequest) {
        if (snapshotStreamId !== null && !this.state.allocatedSnapshotStreams.some(s => s.snapshotStreamId === snapshotStreamId)) {
            throw notFound("Snapshot stream");
        }
        const ctx = contextOf(this.endpoint);
        const width = requestedResolution?.width || undefined;
        const height = requestedResolution?.height || undefined;
        let image: Buffer | undefined;
        if (ctx.domain === "camera") {
            image = await ctx.ha.cameraImage(ctx.entityId, width, height).catch(e => {
                log.debug(`Snapshot via Home Assistant failed: ${e instanceof Error ? e.message : e}`);
                return undefined;
            });
        }
        image ??= await sourceOf(this.endpoint).snapshot(width, height);
        const size = jpegSize(image) ?? { width: width ?? 0, height: height ?? 0 };
        return { data: new Uint8Array(image), imageCodec: ImageCodec.Jpeg, resolution: size };
    }
}

// -------------------------------------------------------------------------------------------------------------
// WebRTC transport provider
// -------------------------------------------------------------------------------------------------------------

interface ResolvedStreams {
    video?: number;
    audio?: number;
    /** Deprecated id fields echoed in the command response (only if the request used them) */
    response: { videoStreamId?: number | null; audioStreamId?: number | null };
    /** Stream fields stored in the WebRTCSessionStruct */
    session: { videoStreamId?: number | null; audioStreamId?: number | null; videoStreams?: number[]; audioStreams?: number[] };
}

type RemoteContext = {
    session?: { peerAddress?: PeerAddress };
    fabric?: number;
};

function iceServersOf(request: { iceServers?: WebRtcTransportDefinitions.IceServer[] }): IceServerConfig[] {
    return (request.iceServers ?? []).map(s => ({ urls: s.urLs, username: s.username, credential: s.credential }));
}

export class HaWebRtcTransportProviderServer extends WebRtcTransportProviderServer {
    override initialize() {
        this.state.currentSessions = [];
    }

    #peer(): { peer: PeerAddress; fabricIndex: number } {
        const context = this.context as unknown as RemoteContext;
        const peer = context.session?.peerAddress;
        if (!peer || context.fabric === undefined) {
            throw new StatusResponseError("WebRTC requires an operational session", Status.UnsupportedAccess);
        }
        return { peer, fabricIndex: Number(context.fabric) };
    }

    #avState() {
        return (this.endpoint.state as any).cameraAvStreamManagement as HaCameraAvStreamManagementServer["state"];
    }

    /**
     * Resolves the video/audio streams of a new session. Supports the list fields of cluster revision 2
     * (VideoStreams/AudioStreams) as well as the deprecated single id fields (null = choose automatically).
     */
    #resolveStreams(request: {
        streamUsage: StreamUsage;
        videoStreamId?: number | null;
        audioStreamId?: number | null;
        videoStreams?: number[];
        audioStreams?: number[];
    }): ResolvedStreams {
        const av = this.#avState();
        if (!av.supportedStreamUsages.includes(request.streamUsage)) {
            throw new StatusResponseError("Unsupported stream usage", Status.InvalidCommand);
        }
        const videoIds = av.allocatedVideoStreams.map(s => s.videoStreamId);
        const audioIds = av.allocatedAudioStreams.map(s => s.audioStreamId);
        const autoVideo = () =>
            av.allocatedVideoStreams.find(s => s.streamUsage === request.streamUsage)?.videoStreamId ?? videoIds[0];
        const autoAudio = () =>
            av.allocatedAudioStreams.find(s => s.streamUsage === request.streamUsage)?.audioStreamId ?? audioIds[0];

        let video: number | undefined;
        let audio: number | undefined;
        const response: { videoStreamId?: number | null; audioStreamId?: number | null } = {};
        const session: { videoStreamId?: number | null; audioStreamId?: number | null; videoStreams?: number[]; audioStreams?: number[] } = {};

        if (request.videoStreams?.length) {
            if (request.videoStreams.some(id => !videoIds.includes(id))) {
                throw new StatusResponseError("Video stream not allocated", Status.DynamicConstraintError);
            }
            video = request.videoStreams[0];
            session.videoStreams = [...request.videoStreams];
        } else if (request.videoStreamId !== undefined) {
            video = request.videoStreamId === null ? autoVideo() : request.videoStreamId;
            if (video === undefined || !videoIds.includes(video)) {
                throw new StatusResponseError("Video stream not allocated", Status.InvalidInState);
            }
            response.videoStreamId = video;
            session.videoStreamId = video;
        } else {
            video = autoVideo();
        }

        if (request.audioStreams?.length) {
            if (request.audioStreams.some(id => !audioIds.includes(id))) {
                throw new StatusResponseError("Audio stream not allocated", Status.DynamicConstraintError);
            }
            audio = request.audioStreams[0];
            session.audioStreams = [...request.audioStreams];
        } else if (request.audioStreamId !== undefined) {
            audio = request.audioStreamId === null ? autoAudio() : request.audioStreamId;
            if (audio === undefined || !audioIds.includes(audio)) {
                throw new StatusResponseError("Audio stream not allocated", Status.InvalidInState);
            }
            response.audioStreamId = audio;
            session.audioStreamId = audio;
        }

        if (video === undefined && audio === undefined) {
            throw new StatusResponseError("No stream allocated", Status.InvalidInState);
        }
        return { video, audio, response, session };
    }

    #registerSession(
        id: number,
        session: CameraWebRtcSession,
        peer: PeerAddress,
        fabricIndex: number,
        peerEndpoint: number,
        streamUsage: StreamUsage,
        streams: ResolvedStreams,
    ) {
        const videoStreamId = streams.video;
        const audioStreamId = streams.audio;
        const runtime = runtimeOf(this.endpoint);
        runtime.sessions.set(id, { session, peer, peerEndpoint });
        this.state.currentSessions = [
            ...this.state.currentSessions,
            {
                id,
                peerNodeId: peer.nodeId,
                peerEndpointId: EndpointNumber(peerEndpoint),
                streamUsage,
                ...streams.session,
                metadataEnabled: false,
                fabricIndex: fabricIndex as any,
            },
        ];
        this.#changeReferences(videoStreamId, audioStreamId, +1);

        const endpoint = this.endpoint;
        session.onLocalCandidate = candidate => {
            void sendToRequestor(endpoint, peer, peerEndpoint, "iceCandidates", {
                webRtcSessionId: id,
                iceCandidates: [{ candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpmLineIndex: candidate.sdpMLineIndex }],
            });
        };
        session.onClosed = failed => {
            runtime.sessions.delete(id);
            void removeSessionState(endpoint, id, videoStreamId, audioStreamId);
            if (failed) {
                void sendToRequestor(endpoint, peer, peerEndpoint, "end", { webRtcSessionId: id, reason: EndReason.IceFailed });
            }
        };
    }

    #changeReferences(videoStreamId: number | undefined, audioStreamId: number | undefined, delta: number) {
        const av = this.#avState() as any;
        const update: Record<string, unknown> = {};
        if (videoStreamId !== undefined) {
            update.allocatedVideoStreams = av.allocatedVideoStreams.map((s: any) =>
                s.videoStreamId === videoStreamId ? { ...s, referenceCount: Math.max(0, s.referenceCount + delta) } : s,
            );
        }
        if (audioStreamId !== undefined) {
            update.allocatedAudioStreams = av.allocatedAudioStreams.map((s: any) =>
                s.audioStreamId === audioStreamId ? { ...s, referenceCount: Math.max(0, s.referenceCount + delta) } : s,
            );
        }
        if (Object.keys(update).length) {
            const endpoint = this.endpoint;
            // Applied after the current transaction to avoid locking the other behavior
            setImmediate(() => endpoint.set({ cameraAvStreamManagement: update } as any).catch(() => undefined));
        }
    }

    #session(id: number) {
        const entry = runtimeOf(this.endpoint).sessions.get(id);
        if (!entry) throw notFound("WebRTC session");
        const { peer } = this.#peer();
        if (entry.peer.nodeId !== peer.nodeId || entry.peer.fabricIndex !== peer.fabricIndex) {
            throw notFound("WebRTC session");
        }
        return entry;
    }

    override async solicitOffer(request: WebRtcTransportProvider.SolicitOfferRequest) {
        const { peer, fabricIndex } = this.#peer();
        const source = sourceOf(this.endpoint);
        const streams = this.#resolveStreams(request);
        const runtime = runtimeOf(this.endpoint);
        const id = runtime.nextSessionId++ & 0xffff;
        const session = new CameraWebRtcSession(id, source, iceServersOf(request), request.iceTransportPolicy);
        this.#registerSession(id, session, peer, fabricIndex, request.originatingEndpointId, request.streamUsage, streams);

        // The offer is generated and delivered after this command has been answered
        const endpoint = this.endpoint;
        const withAudio = streams.audio !== undefined && (await source.info().then(i => i.hasAudio).catch(() => false));
        setImmediate(async () => {
            try {
                const sdp = await session.offer(withAudio);
                await sendToRequestor(endpoint, peer, request.originatingEndpointId, "offer", { webRtcSessionId: id, sdp });
            } catch (e) {
                log.error(`[${source.name}] Could not create WebRTC offer: ${e instanceof Error ? e.message : e}`);
                session.close(true);
            }
        });
        return { webRtcSessionId: id, deferredOffer: false, ...streams.response };
    }

    override async provideOffer(request: WebRtcTransportProvider.ProvideOfferRequest) {
        const { peer, fabricIndex } = this.#peer();
        const source = sourceOf(this.endpoint);
        const endpoint = this.endpoint;

        // Re-negotiation of an existing session
        if (request.webRtcSessionId !== null) {
            const entry = this.#session(request.webRtcSessionId);
            const id = request.webRtcSessionId;
            setImmediate(async () => {
                try {
                    const sdp = await entry.session.answer(request.sdp);
                    await sendToRequestor(endpoint, peer, entry.peerEndpoint, "answer", { webRtcSessionId: id, sdp });
                } catch (e) {
                    log.error(`[${source.name}] WebRTC re-negotiation failed: ${e instanceof Error ? e.message : e}`);
                }
            });
            return { webRtcSessionId: id };
        }

        if (request.streamUsage === undefined || request.originatingEndpointId === undefined) {
            throw new StatusResponseError("StreamUsage and OriginatingEndpointID are required", Status.InvalidCommand);
        }
        const streamUsage = request.streamUsage;
        const peerEndpoint = request.originatingEndpointId;
        const streams = this.#resolveStreams({ ...request, streamUsage });
        const runtime = runtimeOf(this.endpoint);
        const id = runtime.nextSessionId++ & 0xffff;
        const session = new CameraWebRtcSession(id, source, iceServersOf(request), request.iceTransportPolicy);
        this.#registerSession(id, session, peer, fabricIndex, peerEndpoint, streamUsage, streams);

        // Spec: the answer is sent with the Answer command after responding to ProvideOffer
        setImmediate(async () => {
            try {
                const sdp = await session.answer(request.sdp);
                await sendToRequestor(endpoint, peer, peerEndpoint, "answer", { webRtcSessionId: id, sdp });
            } catch (e) {
                log.error(`[${source.name}] Could not answer WebRTC offer: ${e instanceof Error ? e.message : e}`);
                session.close(true);
            }
        });
        return { webRtcSessionId: id, ...streams.response };
    }

    override async provideAnswer({ webRtcSessionId, sdp }: WebRtcTransportProvider.ProvideAnswerRequest) {
        const { session } = this.#session(webRtcSessionId);
        await session.applyAnswer(sdp);
    }

    override async provideIceCandidates({ webRtcSessionId, iceCandidates }: WebRtcTransportProvider.ProvideIceCandidatesRequest) {
        const { session } = this.#session(webRtcSessionId);
        await session.addCandidates(
            iceCandidates.map(c => ({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpmLineIndex })),
        );
    }

    override endSession({ webRtcSessionId, reason }: WebRtcTransportProvider.EndSessionRequest) {
        const { session } = this.#session(webRtcSessionId);
        log.info(`[${session.source.name}] Live view session ${webRtcSessionId} ended (${EndReason[reason] ?? reason})`);
        session.close();
    }
}

async function removeSessionState(endpoint: Endpoint, id: number, videoStreamId?: number, audioStreamId?: number) {
    try {
        const state = endpoint.state as any;
        const update: Record<string, any> = {
            webRtcTransportProvider: {
                currentSessions: state.webRtcTransportProvider.currentSessions.filter((s: any) => s.id !== id),
            },
        };
        const av = state.cameraAvStreamManagement;
        const dec = (list: any[], key: string, streamId?: number) =>
            list.map(s => (streamId !== undefined && s[key] === streamId ? { ...s, referenceCount: Math.max(0, s.referenceCount - 1) } : s));
        update.cameraAvStreamManagement = {
            allocatedVideoStreams: dec(av.allocatedVideoStreams, "videoStreamId", videoStreamId),
            allocatedAudioStreams: dec(av.allocatedAudioStreams, "audioStreamId", audioStreamId),
        };
        await endpoint.set(update);
    } catch (e) {
        log.debug(`Could not update camera session state: ${e instanceof Error ? e.message : e}`);
    }
}

/** Invokes a command of the WebRtcTransportRequestor cluster on the controller that owns the session */
async function sendToRequestor(
    endpoint: Endpoint,
    peer: PeerAddress,
    peerEndpoint: number,
    command: "offer" | "answer" | "iceCandidates" | "end",
    fields: Record<string, unknown>,
) {
    try {
        const node = endpoint.env.get(ServerNode);
        const client = await node.peers.forAddress(peer);
        const invoke = Invoke({
            commands: [
                Invoke.ConcreteCommandRequest({
                    endpoint: EndpointNumber(peerEndpoint),
                    cluster: WebRtcTransportRequestor,
                    command,
                    fields,
                } as any),
            ],
        });
        for await (const chunk of client.interaction.invoke(invoke)) {
            for (const entry of chunk as any[]) {
                if (entry.kind === "cmd-status" && entry.status !== Status.Success) {
                    throw new Error(`controller answered with status ${Status[entry.status] ?? entry.status}`);
                }
            }
        }
        log.debug(`Sent WebRTC ${command} to controller ${peer.nodeId}`);
    } catch (e) {
        log.warn(`Could not send WebRTC ${command} to controller: ${e instanceof Error ? e.message : e}`);
    }
}
