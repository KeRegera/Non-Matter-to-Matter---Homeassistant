import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "../log.js";
import type {
    HassAreaRegistryEntry,
    HassDeviceRegistryEntry,
    HassEntity,
    HassEntityRegistryEntry,
    HassLabelRegistryEntry,
} from "./types.js";

interface Pending {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * Minimal Home Assistant WebSocket API client.
 *
 * Emits:
 *  - "state" (entity: HassEntity | undefined, entityId: string) whenever an entity changes or is removed
 *  - "connected" after (re-)authentication and initial state load
 *  - "registry" when the entity/device/area registries changed
 */
export class HomeAssistantClient extends EventEmitter {
    readonly states = new Map<string, HassEntity>();
    entityRegistry = new Map<string, HassEntityRegistryEntry>();
    deviceRegistry = new Map<string, HassDeviceRegistryEntry>();
    areaRegistry = new Map<string, HassAreaRegistryEntry>();
    labelRegistry = new Map<string, HassLabelRegistryEntry>();
    /** Temperature unit configured in Home Assistant ("°C" or "°F") */
    temperatureUnit = "°C";

    #ws?: WebSocket;
    #nextId = 1;
    #pending = new Map<number, Pending>();
    #connected = false;
    #closed = false;
    #reconnectDelay = 1000;
    #registryReloadTimer?: NodeJS.Timeout;

    constructor(
        private readonly url: string,
        private readonly token: string,
    ) {
        super();
    }

    get connected() {
        return this.#connected;
    }

    /** Connects and resolves after the first successful connection (retries forever). */
    async connect(): Promise<void> {
        await new Promise<void>(resolve => {
            this.once("connected", () => resolve());
            this.#open();
        });
    }

    close() {
        this.#closed = true;
        this.#ws?.close();
    }

    #open() {
        if (this.#closed) return;
        log.info(`Connecting to Home Assistant at ${this.url}`);
        const ws = new WebSocket(this.url);
        this.#ws = ws;

        ws.on("message", data => this.#onMessage(data.toString()).catch(e => log.error("HA message error", e)));
        ws.on("error", error => log.warn(`Home Assistant connection error: ${error.message}`));
        ws.on("close", () => {
            const wasConnected = this.#connected;
            this.#connected = false;
            for (const [, pending] of this.#pending) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Connection to Home Assistant lost"));
            }
            this.#pending.clear();
            if (this.#closed) return;
            if (wasConnected) {
                log.warn("Connection to Home Assistant lost, reconnecting...");
                this.emit("disconnected");
            }
            setTimeout(() => this.#open(), this.#reconnectDelay);
            this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
        });
    }

    async #onMessage(raw: string) {
        const messages = raw.startsWith("[") ? JSON.parse(raw) : [JSON.parse(raw)];
        for (const message of messages) {
            switch (message.type) {
                case "auth_required":
                    this.#send({ type: "auth", access_token: this.token });
                    break;
                case "auth_ok":
                    log.info(`Authenticated with Home Assistant ${message.ha_version}`);
                    this.#reconnectDelay = 1000;
                    await this.#initialize();
                    break;
                case "auth_invalid":
                    log.error(`Home Assistant authentication failed: ${message.message}`);
                    this.#ws?.close();
                    break;
                case "result": {
                    const pending = this.#pending.get(message.id);
                    if (!pending) break;
                    this.#pending.delete(message.id);
                    clearTimeout(pending.timer);
                    if (message.success) pending.resolve(message.result);
                    else
                        pending.reject(
                            new Error(message.error?.message ?? `Home Assistant request failed (${message.error?.code})`),
                        );
                    break;
                }
                case "event":
                    this.#onEvent(message.event);
                    break;
            }
        }
    }

    async #initialize() {
        try {
            await this.#loadRegistries();
            const config = await this.request({ type: "get_config" }).catch(() => undefined);
            if (config?.unit_system?.temperature) this.temperatureUnit = config.unit_system.temperature;
            const states: HassEntity[] = await this.request({ type: "get_states" });
            const previous = new Set(this.states.keys());
            this.states.clear();
            for (const state of states) this.states.set(state.entity_id, state);

            await this.request({ type: "subscribe_events", event_type: "state_changed" });
            for (const event_type of [
                "entity_registry_updated",
                "device_registry_updated",
                "area_registry_updated",
                "label_registry_updated",
            ]) {
                await this.request({ type: "subscribe_events", event_type }).catch(() => undefined);
            }

            this.#connected = true;
            this.emit("connected");

            // Notify about everything that changed while we were disconnected
            for (const state of states) this.emit("state", state, state.entity_id);
            for (const id of previous) if (!this.states.has(id)) this.emit("state", undefined, id);
        } catch (e) {
            log.error("Failed to initialize Home Assistant connection", e);
            this.#ws?.close();
        }
    }

    async #loadRegistries() {
        const [entities, devices, areas, labels] = await Promise.all([
            this.request<HassEntityRegistryEntry[]>({ type: "config/entity_registry/list" }).catch(() => []),
            this.request<HassDeviceRegistryEntry[]>({ type: "config/device_registry/list" }).catch(() => []),
            this.request<HassAreaRegistryEntry[]>({ type: "config/area_registry/list" }).catch(() => []),
            this.request<HassLabelRegistryEntry[]>({ type: "config/label_registry/list" }).catch(() => []),
        ]);
        this.entityRegistry = new Map(entities.map(e => [e.entity_id, e]));
        this.deviceRegistry = new Map(devices.map(d => [d.id, d]));
        this.areaRegistry = new Map(areas.map(a => [a.area_id, a]));
        this.labelRegistry = new Map(labels.map(l => [l.label_id, l]));
    }

    #onEvent(event: any) {
        if (event.event_type === "state_changed") {
            const { entity_id, new_state } = event.data;
            if (new_state) this.states.set(entity_id, new_state);
            else this.states.delete(entity_id);
            this.emit("state", new_state ?? undefined, entity_id);
            return;
        }
        if (String(event.event_type).endsWith("_registry_updated")) {
            clearTimeout(this.#registryReloadTimer);
            this.#registryReloadTimer = setTimeout(() => {
                this.#loadRegistries()
                    .then(() => this.emit("registry"))
                    .catch(e => log.warn("Registry reload failed", e));
            }, 2000);
        }
    }

    #send(message: object) {
        this.#ws?.send(JSON.stringify(message));
    }

    request<T = any>(message: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Not connected to Home Assistant"));
        }
        const id = this.#nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Home Assistant request ${message.type} timed out`));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            this.#send({ ...message, id });
        });
    }

    async callService(domain: string, service: string, data: Record<string, unknown> = {}) {
        log.debug(`Calling ${domain}.${service} ${JSON.stringify(data)}`);
        return this.request({ type: "call_service", domain, service, service_data: data });
    }

    /** HTTP base URL of the Home Assistant REST API, derived from the WebSocket URL */
    get apiUrl() {
        return this.url
            .replace(/^ws/, "http")
            .replace(/\/core\/websocket$/, "/core/api")
            .replace(/\/api\/websocket$/, "/api");
    }

    /** Server base URL (without /api), used for relative URLs such as HLS playlists */
    get baseUrl() {
        return this.apiUrl.replace(/\/api$/, "");
    }

    /** Fetches the current image of a camera entity */
    async cameraImage(entityId: string, width?: number, height?: number): Promise<Buffer> {
        const params = new URLSearchParams();
        if (width) params.set("width", String(width));
        if (height) params.set("height", String(height));
        const query = params.size ? `?${params}` : "";
        const response = await fetch(`${this.apiUrl}/camera_proxy/${entityId}${query}`, {
            headers: { Authorization: `Bearer ${this.token}` },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`camera_proxy returned ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    }

    /** Returns an HLS stream URL of a camera entity (requires the camera to support streaming) */
    async cameraStreamUrl(entityId: string): Promise<string> {
        const result = await this.request<{ url: string }>({ type: "camera/stream", entity_id: entityId, format: "hls" });
        return result.url.startsWith("http") ? result.url : `${this.baseUrl}${result.url}`;
    }

    // Registry helpers ------------------------------------------------------------------------------------------

    friendlyName(entityId: string): string {
        const state = this.states.get(entityId);
        const reg = this.entityRegistry.get(entityId);
        return state?.attributes.friendly_name ?? reg?.name ?? reg?.original_name ?? entityId;
    }

    deviceOf(entityId: string): HassDeviceRegistryEntry | undefined {
        const deviceId = this.entityRegistry.get(entityId)?.device_id;
        return deviceId ? this.deviceRegistry.get(deviceId) : undefined;
    }

    areaOf(entityId: string): HassAreaRegistryEntry | undefined {
        const reg = this.entityRegistry.get(entityId);
        const areaId = reg?.area_id ?? this.deviceOf(entityId)?.area_id;
        return areaId ? this.areaRegistry.get(areaId) : undefined;
    }

    labelsOf(entityId: string): string[] {
        const ids = new Set<string>([
            ...(this.entityRegistry.get(entityId)?.labels ?? []),
            ...(this.deviceOf(entityId)?.labels ?? []),
        ]);
        const result = new Array<string>();
        for (const id of ids) {
            result.push(id);
            const name = this.labelRegistry.get(id)?.name;
            if (name) result.push(name);
        }
        return result;
    }
}
