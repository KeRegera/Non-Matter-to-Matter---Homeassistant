import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { log } from "../log.js";

export interface StreamInfo {
    videoCodec?: string;
    width?: number;
    height?: number;
    fps?: number;
    hasAudio: boolean;
}

export type RtpListener = (packet: Buffer) => void;

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const IDLE_STOP_MS = 15_000;

const isNetworkUrl = (url: string) => /^(rtsps?|rtmps?|https?|srt|udp|tcp):\/\//i.test(url);

function inputArgs(url: string) {
    if (/^rtsps?:\/\//i.test(url)) return ["-rtsp_transport", "tcp", "-timeout", "10000000", "-i", url];
    if (isNetworkUrl(url)) return ["-i", url];
    // Local files (used for testing) are played in real time and looped
    return ["-re", "-stream_loop", "-1", "-i", url];
}

/** Hides credentials when logging stream URLs */
export const redactUrl = (url: string) => url.replace(/\/\/([^:/@]+):([^@/]+)@/, "//$1:***@");

/**
 * A camera stream (RTSP or other ffmpeg input) that is converted into RTP packets suitable for WebRTC:
 * H.264 video (copied, or transcoded if the camera uses another codec) and Opus audio.
 *
 * ffmpeg only runs while at least one viewer is subscribed.
 */
export class CameraSource {
    #video = new Set<RtpListener>();
    #audio = new Set<RtpListener>();
    #process?: ChildProcess;
    #sockets: Socket[] = [];
    #idleTimer?: NodeJS.Timeout;
    #info?: Promise<StreamInfo>;
    #restartTimer?: NodeJS.Timeout;
    #stopping = false;

    constructor(
        readonly name: string,
        /** Stream URL or a function resolving it (e.g. a Home Assistant HLS URL with a short-lived token) */
        readonly url: string | (() => Promise<string>),
    ) {}

    #resolveUrl() {
        return typeof this.url === "string" ? Promise.resolve(this.url) : this.url();
    }

    /** Reads codec, resolution and audio presence of the stream (cached) */
    info(): Promise<StreamInfo> {
        this.#info ??= this.#resolveUrl().then(url => probe(url)).catch(e => {
            this.#info = undefined;
            throw e;
        });
        return this.#info;
    }

    subscribe(video?: RtpListener, audio?: RtpListener) {
        if (video) this.#video.add(video);
        if (audio) this.#audio.add(audio);
        clearTimeout(this.#idleTimer);
        if (!this.#process) void this.#start();
        return () => {
            if (video) this.#video.delete(video);
            if (audio) this.#audio.delete(audio);
            if (!this.#video.size && !this.#audio.size) {
                clearTimeout(this.#idleTimer);
                this.#idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
            }
        };
    }

    get running() {
        return !!this.#process;
    }

    async #bind(listeners: Set<RtpListener>) {
        const socket = createSocket("udp4");
        socket.on("message", packet => {
            for (const listener of listeners) listener(packet);
        });
        socket.on("error", e => log.warn(`[${this.name}] RTP socket error: ${e.message}`));
        await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve));
        this.#sockets.push(socket);
        return socket.address().port;
    }

    async #start() {
        this.#stopping = false;
        let info: StreamInfo;
        let url: string;
        try {
            info = await this.info();
            url = await this.#resolveUrl();
        } catch (e) {
            log.error(`[${this.name}] Cannot read camera stream: ${e instanceof Error ? e.message : e}`);
            this.#scheduleRestart();
            return;
        }
        if (this.#process || (!this.#video.size && !this.#audio.size)) return;

        const videoPort = await this.#bind(this.#video);
        const audioPort = info.hasAudio ? await this.#bind(this.#audio) : undefined;

        const copyVideo = info.videoCodec === "h264";
        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            ...inputArgs(url),
            "-map",
            "0:v:0",
            ...(copyVideo
                ? ["-c:v", "copy", "-bsf:v", "dump_extra"]
                : ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "50"]),
            "-f",
            "rtp",
            "-payload_type",
            "96",
            "-pkt_size",
            "1200",
            `rtp://127.0.0.1:${videoPort}`,
        ];
        if (audioPort) {
            args.push(
                "-map",
                "0:a:0",
                "-c:a",
                "libopus",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-b:a",
                "48k",
                "-application",
                "lowdelay",
                "-f",
                "rtp",
                "-payload_type",
                "111",
                "-pkt_size",
                "1200",
                `rtp://127.0.0.1:${audioPort}`,
            );
        }

        log.info(`[${this.name}] Starting stream ${redactUrl(url)} (video ${copyVideo ? "copy" : "transcode"}${audioPort ? ", audio opus" : ""})`);
        const child = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
        this.#process = child;
        child.stderr?.on("data", data => log.debug(`[${this.name}] ffmpeg: ${String(data).trim()}`));
        child.on("exit", code => {
            if (this.#process === child) this.#process = undefined;
            this.#closeSockets();
            if (!this.#stopping) {
                log.warn(`[${this.name}] ffmpeg exited (code ${code})`);
                this.#scheduleRestart();
            }
        });
        child.on("error", e => log.error(`[${this.name}] ffmpeg could not be started: ${e.message}`));
    }

    #scheduleRestart() {
        clearTimeout(this.#restartTimer);
        if (!this.#video.size && !this.#audio.size) return;
        this.#restartTimer = setTimeout(() => {
            if (!this.#process && (this.#video.size || this.#audio.size)) void this.#start();
        }, 5000);
    }

    #closeSockets() {
        for (const socket of this.#sockets) {
            try {
                socket.close();
            } catch {
                // already closed
            }
        }
        this.#sockets = [];
    }

    stop() {
        this.#stopping = true;
        clearTimeout(this.#idleTimer);
        clearTimeout(this.#restartTimer);
        if (this.#process) {
            log.info(`[${this.name}] Stopping stream`);
            this.#process.kill("SIGTERM");
            this.#process = undefined;
        }
        this.#closeSockets();
    }

    /** Captures a single JPEG frame from the stream */
    async snapshot(width?: number, height?: number): Promise<Buffer> {
        const url = await this.#resolveUrl();
        const scale = width && height ? ["-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease`] : [];
        const input = /^rtsps?:\/\//i.test(url) ? ["-rtsp_transport", "tcp", "-timeout", "10000000", "-i", url] : ["-i", url];
        return new Promise((resolve, reject) => {
            execFile(
                FFMPEG,
                ["-hide_banner", "-loglevel", "error", ...input, "-frames:v", "1", ...scale, "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "-"],
                { encoding: "buffer", maxBuffer: 20 * 1024 * 1024, timeout: 20_000 },
                (error, stdout) => (error ? reject(error) : resolve(stdout)),
            );
        });
    }
}

function probe(url: string): Promise<StreamInfo> {
    const input = /^rtsps?:\/\//i.test(url) ? ["-rtsp_transport", "tcp", "-timeout", "10000000"] : [];
    return new Promise((resolve, reject) => {
        execFile(
            FFPROBE,
            ["-hide_banner", "-loglevel", "error", ...input, "-show_streams", "-of", "json", url],
            { timeout: 20_000, maxBuffer: 5 * 1024 * 1024 },
            (error, stdout) => {
                if (error) return reject(error);
                try {
                    const streams: any[] = JSON.parse(stdout).streams ?? [];
                    const video = streams.find(s => s.codec_type === "video");
                    if (!video) return reject(new Error("Stream contains no video"));
                    const [num, den] = String(video.avg_frame_rate ?? video.r_frame_rate ?? "0/1").split("/").map(Number);
                    resolve({
                        videoCodec: video.codec_name,
                        width: video.width,
                        height: video.height,
                        fps: den ? Math.round(num / den) : undefined,
                        hasAudio: streams.some(s => s.codec_type === "audio"),
                    });
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}
