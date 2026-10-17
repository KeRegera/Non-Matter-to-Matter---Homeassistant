import WebSocket from "ws";
import { log } from "../log.js";

interface Pending {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class HomeAssistantError extends Error {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
    }
}

/**
 * Small Home Assistant client: WebSocket API (with automatic reconnect) plus REST calls.
 * Inside the add-on both go through the Supervisor proxy with the SUPERVISOR_TOKEN.
 */
export class HomeAssistantClient {
    #ws?: WebSocket;
    #nextId = 1;
    #pending = new Map<number, Pending>();
    #connected = false;
    #reconnectDelay = 1000;
    version?: string;

    constructor(
        private readonly wsUrl: string,
        private readonly restUrl: string,
        private readonly token: string,
    ) {}

    get connected() {
        return this.#connected;
    }

    start() {
        this.#open();
    }

    #open() {
        const ws = new WebSocket(this.wsUrl);
        this.#ws = ws;
        ws.on("message", data => this.#onMessage(data.toString()));
        ws.on("error", error => log.warn(`Home Assistant connection error: ${error.message}`));
        ws.on("close", () => {
            if (this.#connected) log.warn("Connection to Home Assistant lost, reconnecting...");
            this.#connected = false;
            for (const pending of this.#pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new HomeAssistantError("Verbindung zu Home Assistant unterbrochen"));
            }
            this.#pending.clear();
            setTimeout(() => this.#open(), this.#reconnectDelay);
            this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
        });
    }

    #onMessage(raw: string) {
        let messages: any[];
        try {
            messages = raw.startsWith("[") ? JSON.parse(raw) : [JSON.parse(raw)];
        } catch {
            return;
        }
        for (const message of messages) {
            if (message.type === "auth_required") {
                this.#ws?.send(JSON.stringify({ type: "auth", access_token: this.token }));
            } else if (message.type === "auth_ok") {
                this.#connected = true;
                this.#reconnectDelay = 1000;
                this.version = message.ha_version;
                log.info(`Connected to Home Assistant ${message.ha_version}`);
            } else if (message.type === "auth_invalid") {
                log.error(`Home Assistant authentication failed: ${message.message}`);
                this.#ws?.close();
            } else if (message.type === "result") {
                const pending = this.#pending.get(message.id);
                if (!pending) continue;
                this.#pending.delete(message.id);
                clearTimeout(pending.timer);
                if (message.success) pending.resolve(message.result);
                else
                    pending.reject(
                        new HomeAssistantError(
                            message.error?.message ?? `Anfrage fehlgeschlagen (${message.error?.code})`,
                            message.error?.code,
                        ),
                    );
            }
        }
    }

    /** Sends a WebSocket command and waits for its result. */
    request<T = any>(command: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
        if (!this.#connected || !this.#ws) return Promise.reject(new HomeAssistantError("Keine Verbindung zu Home Assistant"));
        const id = this.#nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new HomeAssistantError("Zeitüberschreitung bei der Anfrage an Home Assistant", "timeout"));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            this.#ws!.send(JSON.stringify({ ...command, id }));
        });
    }

    /** REST call against /api/… (path without leading /api). */
    async rest<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
        const response = await fetch(`${this.restUrl}/${path.replace(/^\/+/, "")}`, {
            method,
            headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let data: any = undefined;
        try {
            data = text ? JSON.parse(text) : undefined;
        } catch {
            data = text;
        }
        if (!response.ok) {
            const message = typeof data === "object" && data?.message ? data.message : String(text).slice(0, 200);
            throw new HomeAssistantError(`Home Assistant meldet ${response.status}: ${message}`, String(response.status));
        }
        return data as T;
    }
}
