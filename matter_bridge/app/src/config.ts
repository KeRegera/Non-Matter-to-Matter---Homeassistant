import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

export const DATA_DIR = process.env.DATA_DIR ?? "/data";

/** Options configured on the add-on configuration page (/data/options.json) */
export interface AddonOptions {
    log_level: string;
    bridge_name: string;
    port: number;
    passcode?: number;
    discriminator?: number;
    network_interface?: string;
    include_domains: string[];
    include_labels: string[];
    exclude_entities: string[];
    exclude_hidden: boolean;
    matter_tcp: boolean;
}

/** Per-entity settings managed by the web UI */
export interface EntitySettings {
    /** true = always expose, false = never expose, undefined = use automatic rules */
    enabled?: boolean;
    /** Override of the Matter device type (mapper id) */
    type?: string;
    /** Custom name shown in the Matter controller */
    name?: string;
    /** Code for locks / alarm panels that require one */
    code?: string;
    /** Camera stream URL (RTSP etc.); if empty, the Home Assistant stream of the camera entity is used */
    streamUrl?: string;
}

export interface BridgeConfig {
    entities: Record<string, EntitySettings>;
}

const defaults: AddonOptions = {
    log_level: "info",
    bridge_name: "HA Matter Bridge",
    port: 5540,
    include_domains: [],
    include_labels: ["matter"],
    exclude_entities: [],
    exclude_hidden: true,
    matter_tcp: true,
};

function readJson<T>(file: string): T | undefined {
    try {
        if (!existsSync(file)) return undefined;
        return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch (e) {
        log.warn(`Could not read ${file}`, e);
        return undefined;
    }
}

function writeJson(file: string, value: unknown) {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
}

export function loadOptions(): AddonOptions {
    const raw = readJson<Partial<AddonOptions>>(join(DATA_DIR, "options.json")) ?? {};
    const options = { ...defaults, ...raw } as AddonOptions;
    options.include_domains = options.include_domains ?? [];
    options.include_labels = (options.include_labels ?? []).map(l => l.toLowerCase());
    options.exclude_entities = options.exclude_entities ?? [];
    if (!options.passcode) delete options.passcode;
    if (options.discriminator === null || options.discriminator === undefined) delete options.discriminator;
    if (!options.network_interface) delete options.network_interface;
    return options;
}

const INVALID_PASSCODES = new Set([
    0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321,
]);

/** Pairing credentials are generated once and persisted unless configured explicitly */
export function loadCredentials(options: AddonOptions) {
    const file = join(DATA_DIR, "credentials.json");
    let stored = readJson<{ passcode: number; discriminator: number }>(file);
    if (!stored) {
        let passcode = 0;
        while (INVALID_PASSCODES.has(passcode)) passcode = randomInt(1, 99999998);
        stored = { passcode, discriminator: randomInt(0, 4096) };
        writeJson(file, stored);
    }
    const passcode = options.passcode && !INVALID_PASSCODES.has(options.passcode) ? options.passcode : stored.passcode;
    const discriminator =
        options.discriminator !== undefined && options.discriminator >= 0 && options.discriminator <= 4095
            ? options.discriminator
            : stored.discriminator;
    return { passcode, discriminator };
}

export class ConfigStore {
    #file = join(DATA_DIR, "bridge.json");
    #cacheFile = join(DATA_DIR, "entity-cache.json");
    config: BridgeConfig;
    /** Last known attributes of entities, used while an entity is unavailable */
    attributeCache: Record<string, { signature: string; attributes: Record<string, unknown> }>;
    #cacheTimer?: NodeJS.Timeout;

    constructor() {
        this.config = readJson<BridgeConfig>(this.#file) ?? { entities: {} };
        this.config.entities ??= {};
        this.attributeCache = readJson(this.#cacheFile) ?? {};
    }

    settings(entityId: string): EntitySettings {
        return this.config.entities[entityId] ?? {};
    }

    update(entityId: string, patch: EntitySettings) {
        const current = { ...this.settings(entityId), ...patch };
        for (const key of Object.keys(current) as (keyof EntitySettings)[]) {
            if (current[key] === undefined || current[key] === null || current[key] === "") delete current[key];
        }
        if (Object.keys(current).length) this.config.entities[entityId] = current;
        else delete this.config.entities[entityId];
        writeJson(this.#file, this.config);
    }

    /** Stores attributes of an entity whenever its Matter structure (signature) changes */
    cacheAttributes(entityId: string, signature: string, attributes: Record<string, unknown>) {
        if (this.attributeCache[entityId]?.signature === signature) return;
        this.attributeCache[entityId] = { signature, attributes: JSON.parse(JSON.stringify(attributes)) };
        clearTimeout(this.#cacheTimer);
        this.#cacheTimer = setTimeout(() => writeJson(this.#cacheFile, this.attributeCache), 5000);
    }
}
