import {
    MediaStreamTrack,
    RTCIceCandidate,
    RTCPeerConnection,
    RTCRtpCodecParameters,
    type RTCIceServer,
    type RTCRtpTransceiver,
} from "werift";
import { log } from "../log.js";
import type { CameraSource } from "./source.js";

export interface IceServerConfig {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface IceCandidateInit {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
}

const videoCodecs = () => [
    new RTCRtpCodecParameters({
        mimeType: "video/H264",
        clockRate: 90000,
        rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }],
        parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    }),
    new RTCRtpCodecParameters({
        mimeType: "video/H264",
        clockRate: 90000,
        rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }],
        parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032",
    }),
];

const audioCodecs = () => [
    new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 }),
];

/**
 * One WebRTC viewer of a camera. Sends the camera's H.264 video and Opus audio (send-only).
 */
export class CameraWebRtcSession {
    readonly pc: RTCPeerConnection;
    readonly #videoTrack = new MediaStreamTrack({ kind: "video" });
    readonly #audioTrack = new MediaStreamTrack({ kind: "audio" });
    #unsubscribe?: () => void;
    #closed = false;
    onClosed?: (failed: boolean) => void;
    onLocalCandidate?: (candidate: IceCandidateInit) => void;

    constructor(
        readonly id: number,
        readonly source: CameraSource,
        iceServers: IceServerConfig[] = [],
        iceTransportPolicy?: string,
    ) {
        this.pc = new RTCPeerConnection({
            codecs: { video: videoCodecs(), audio: audioCodecs() },
            iceServers: iceServers.flatMap(s =>
                s.urls.map(urls => ({ urls, username: s.username, credential: s.credential }) as RTCIceServer),
            ),
            iceTransportPolicy: iceTransportPolicy === "relay" ? "relay" : "all",
        });
        this.pc.connectionStateChange.subscribe(state => {
            log.debug(`[${source.name}] WebRTC session ${id}: ${state}`);
            if (state === "connected") log.info(`[${source.name}] Live view session ${id} connected`);
            if (state === "failed" || state === "closed") this.close(state === "failed");
        });
        this.pc.onIceCandidate.subscribe(candidate => {
            if (!candidate || !this.onLocalCandidate) return;
            const json = candidate.toJSON();
            this.onLocalCandidate({
                candidate: json.candidate ?? "",
                sdpMid: json.sdpMid ?? null,
                sdpMLineIndex: json.sdpMLineIndex ?? null,
            });
        });
    }

    #attachMedia() {
        if (this.#unsubscribe) return;
        this.#unsubscribe = this.source.subscribe(
            packet => this.#videoTrack.writeRtp(packet),
            packet => this.#audioTrack.writeRtp(packet),
        );
    }

    #useTransceivers(transceivers: RTCRtpTransceiver[]) {
        for (const transceiver of transceivers) {
            if (transceiver.kind === "video") {
                transceiver.sender.replaceTrack(this.#videoTrack);
                transceiver.setDirection("sendonly");
            } else if (transceiver.kind === "audio") {
                transceiver.sender.replaceTrack(this.#audioTrack);
                transceiver.setDirection("sendonly");
            }
        }
    }

    /** Controller sent an offer (ProvideOffer): returns our answer including ICE candidates */
    async answer(offerSdp: string): Promise<string> {
        await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
        this.#useTransceivers(this.pc.getTransceivers());
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.#gathered();
        this.#attachMedia();
        return this.pc.localDescription!.sdp;
    }

    /** Controller asked us to create an offer (SolicitOffer) */
    async offer(withAudio: boolean): Promise<string> {
        this.pc.addTransceiver(this.#videoTrack, { direction: "sendonly" });
        if (withAudio) this.pc.addTransceiver(this.#audioTrack, { direction: "sendonly" });
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        await this.#gathered();
        return this.pc.localDescription!.sdp;
    }

    /** Controller answered our offer (ProvideAnswer) */
    async applyAnswer(answerSdp: string) {
        await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        this.#attachMedia();
    }

    async addCandidates(candidates: IceCandidateInit[]) {
        for (const c of candidates) {
            if (!c.candidate) continue;
            try {
                await this.pc.addIceCandidate(
                    new RTCIceCandidate({
                        candidate: c.candidate,
                        sdpMid: c.sdpMid ?? undefined,
                        sdpMLineIndex: c.sdpMLineIndex ?? undefined,
                    }),
                );
            } catch (e) {
                log.debug(`[${this.source.name}] Ignoring ICE candidate: ${e instanceof Error ? e.message : e}`);
            }
        }
    }

    /** Waits until ICE gathering is complete so the SDP contains all candidates (max. 3 s) */
    async #gathered() {
        if (this.pc.iceGatheringState === "complete") return;
        await new Promise<void>(resolve => {
            const timer = setTimeout(done, 3000);
            const sub = this.pc.iceGatheringStateChange.subscribe(state => {
                if (state === "complete") done();
            });
            function done() {
                clearTimeout(timer);
                sub.unSubscribe();
                resolve();
            }
        });
    }

    get closed() {
        return this.#closed;
    }

    close(failed = false) {
        if (this.#closed) return;
        this.#closed = true;
        this.#unsubscribe?.();
        this.pc.close().catch(() => undefined);
        this.onClosed?.(failed);
    }
}
