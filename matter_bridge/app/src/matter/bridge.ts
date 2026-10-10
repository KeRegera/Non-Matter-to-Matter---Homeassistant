import { createHash } from "node:crypto";
import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import { join } from "node:path";
import { type AddonOptions, type ConfigStore, DATA_DIR } from "../config.js";
import type { HomeAssistantClient } from "../ha/client.js";
import type { HassEntity } from "../ha/types.js";
import { log } from "../log.js";
import { closeCameraSessions } from "../camera/behaviors.js";
import { EntityContext, registerContext, unregisterContext } from "./context.js";
import { truncate } from "./convert.js";
import { type DeviceMapper, selectMapper } from "./mappers.js";

interface BridgedDevice {
    entityId: string;
    endpoint: Endpoint;
    mapper: DeviceMapper;
    signature: string;
    context: EntityContext;
    name: string;
    /** Settings that require rebuilding the endpoint when changed */
    settingsKey: string;
}

export interface ExposureDecision {
    exposed: boolean;
    reason: string;
    mapper?: DeviceMapper;
}

const VERSION = process.env.BRIDGE_VERSION ?? "1.0.0";

/** Domains that are never exposed automatically (they have no useful Matter representation) */
const NEVER_AUTO = new Set(["persistent_notification", "zone", "sun", "update", "conversation", "tts", "stt", "image", "todo", "calendar", "tag", "wake_word", "ai_task"]);

export class MatterBridge {
    server?: ServerNode;
    aggregator?: Endpoint;
    readonly devices = new Map<string, BridgedDevice>();
    #queue: Promise<void> = Promise.resolve();
    #lastErrors = new Map<string, string>();

    constructor(
        readonly options: AddonOptions,
        readonly credentials: { passcode: number; discriminator: number },
        readonly ha: HomeAssistantClient,
        readonly store: ConfigStore,
    ) {}

    async start() {
        const env = Environment.default;
        env.vars.set("storage.path", join(DATA_DIR, "matter"));
        env.vars.set("log.level", this.options.log_level === "debug" ? "debug" : "notice");
        if (this.options.network_interface) env.vars.set("mdns.networkInterface", this.options.network_interface);

        const name = truncate(this.options.bridge_name || "HA Matter Bridge", 32);
        this.server = await ServerNode.create({
            id: "ha-matter-bridge",
            network: { port: this.options.port, tcp: this.options.matter_tcp },
            commissioning: {
                passcode: this.credentials.passcode,
                discriminator: this.credentials.discriminator,
            },
            productDescription: { name, deviceType: AggregatorEndpoint.deviceType },
            basicInformation: {
                vendorName: "Home Assistant",
                vendorId: VendorId(0xfff1),
                nodeLabel: name,
                productName: "HA Matter Bridge",
                productLabel: name,
                productId: 0x8000,
                serialNumber: truncate(createHash("sha256").update(DATA_DIR + name).digest("hex"), 32),
                uniqueId: truncate(createHash("sha256").update("ha-matter-bridge").digest("hex"), 32),
                softwareVersion: 1,
                softwareVersionString: VERSION,
                hardwareVersion: 1,
                hardwareVersionString: "1.0",
            },
        });

        this.aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
        await this.server.add(this.aggregator);

        await this.sync();

        this.server.lifecycle.commissioned.on(() => log.info("Bridge was paired with a Matter controller"));
        this.server.lifecycle.decommissioned.on(() => log.info("Bridge was removed from all Matter controllers"));

        await this.server.start();
        this.logPairingInfo();

        this.ha.on("state", (entity: HassEntity | undefined, entityId: string) =>
            this.#enqueue(() => this.#onState(entity, entityId)),
        );
        this.ha.on("registry", () => this.requestSync());
        this.ha.on("disconnected", () => this.#enqueue(() => this.#markAllUnreachable()));
    }

    logPairingInfo() {
        const commissioning = this.server?.state.commissioning;
        if (!commissioning) return;
        if (commissioning.commissioned) {
            log.info(`Bridge is paired with ${Object.keys(commissioning.fabrics).length} controller(s)`);
        }
        log.info(`Manual pairing code: ${commissioning.pairingCodes.manualPairingCode}`);
        log.info(`QR code payload: ${commissioning.pairingCodes.qrPairingCode}`);
    }

    async stop() {
        await this.server?.close();
    }

    /** Erases all pairings and restarts commissioning */
    async factoryReset() {
        if (!this.server) return;
        log.warn("Factory reset requested - removing all Matter pairings");
        await this.server.erase();
        await this.server.start();
        this.logPairingInfo();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Exposure rules
    // ---------------------------------------------------------------------------------------------------------

    /** Combines live state and cached attributes so that unavailable entities keep their Matter structure */
    effectiveEntity(entityId: string): HassEntity | undefined {
        const live = this.ha.states.get(entityId);
        const cached = this.store.attributeCache[entityId];
        if (!live) {
            return cached ? { entity_id: entityId, state: "unavailable", attributes: cached.attributes } : undefined;
        }
        if (live.state === "unavailable" && cached) {
            return { ...live, attributes: { ...cached.attributes, ...live.attributes } };
        }
        return live;
    }

    decide(entityId: string): ExposureDecision {
        const entity = this.effectiveEntity(entityId);
        if (!entity) return { exposed: false, reason: "Entität existiert nicht" };
        const settings = this.store.settings(entityId);
        const mapper = selectMapper(entity, settings.type);
        if (!mapper) return { exposed: false, reason: "Kein passender Matter-Gerätetyp" };
        if (settings.enabled === true) return { exposed: true, reason: "Manuell freigegeben", mapper };
        if (settings.enabled === false) return { exposed: false, reason: "Manuell ausgeschlossen", mapper };

        const domain = entityId.split(".")[0];
        const reg = this.ha.entityRegistry.get(entityId);
        if (this.options.exclude_entities.includes(entityId)) {
            return { exposed: false, reason: "In den Add-on-Optionen ausgeschlossen", mapper };
        }
        if (reg?.disabled_by) return { exposed: false, reason: "In Home Assistant deaktiviert", mapper };

        const labels = this.ha.labelsOf(entityId).map(l => l.toLowerCase());
        if (this.options.include_labels.some(l => labels.includes(l))) {
            return { exposed: true, reason: "Label", mapper };
        }
        if (this.options.include_domains.includes(domain) && !NEVER_AUTO.has(domain)) {
            if (this.options.exclude_hidden && (reg?.hidden_by || reg?.entity_category)) {
                return { exposed: false, reason: "Versteckt / Diagnose-Entität", mapper };
            }
            return { exposed: true, reason: "Domain", mapper };
        }
        return { exposed: false, reason: "Nicht ausgewählt", mapper };
    }

    // ---------------------------------------------------------------------------------------------------------
    // Synchronisation
    // ---------------------------------------------------------------------------------------------------------

    requestSync() {
        this.#enqueue(() => this.sync());
    }

    #enqueue(task: () => Promise<void>) {
        this.#queue = this.#queue.then(task).catch(e => log.error("Bridge task failed", e));
        return this.#queue;
    }

    /** Waits until all queued work is done */
    async idle() {
        await this.#queue;
    }

    async sync() {
        const wanted = new Map<string, DeviceMapper>();
        const candidates = new Set([...this.ha.states.keys(), ...Object.keys(this.store.config.entities)]);
        for (const entityId of candidates) {
            const decision = this.decide(entityId);
            if (decision.exposed && decision.mapper) wanted.set(entityId, decision.mapper);
        }

        for (const [entityId, device] of this.devices) {
            if (!wanted.has(entityId)) await this.#remove(device);
        }
        for (const [entityId, mapper] of wanted) {
            const existing = this.devices.get(entityId);
            const entity = this.effectiveEntity(entityId)!;
            const signature = mapper.signature(entity);
            const name = this.#name(entityId);
            if (
                existing &&
                existing.mapper === mapper &&
                existing.signature === signature &&
                existing.name === name &&
                existing.settingsKey === this.#settingsKey(entityId)
            ) {
                existing.context.alarmCode = this.store.settings(entityId).code;
                continue;
            }
            if (existing) await this.#remove(existing);
            await this.#add(entityId, mapper);
        }
        log.info(`Bridge exposes ${this.devices.size} device(s)`);
    }

    #settingsKey(entityId: string) {
        return JSON.stringify({ streamUrl: this.store.settings(entityId).streamUrl ?? "" });
    }

    #name(entityId: string) {
        return truncate(this.store.settings(entityId).name || this.ha.friendlyName(entityId), 32);
    }

    async #add(entityId: string, mapper: DeviceMapper) {
        if (!this.aggregator) return;
        const entity = this.effectiveEntity(entityId);
        if (!entity) return;
        const endpointId = entityId.replace(/[^a-zA-Z0-9_]/g, "_");
        const context = new EntityContext(entityId, this.ha);
        context.alarmCode = this.store.settings(entityId).code;
        context.settings = this.store.settings(entityId);
        registerContext(endpointId, context);

        try {
            const { type, state } = mapper.create(entity, context);
            const device = this.ha.deviceOf(entityId);
            const name = this.#name(entityId);
            const hash = createHash("sha256").update(entityId).digest("hex");
            const endpoint = new Endpoint((type as any).with(BridgedDeviceBasicInformationServer), {
                id: endpointId,
                ...state,
                bridgedDeviceBasicInformation: {
                    nodeLabel: name,
                    productName: truncate(device?.model || entityId.split(".")[0], 32),
                    productLabel: truncate(device?.model || name, 64),
                    vendorName: truncate(device?.manufacturer || "Home Assistant", 32),
                    serialNumber: truncate(device?.serial_number || `HA-${hash.slice(0, 16)}`, 32),
                    uniqueId: hash.slice(0, 32),
                    softwareVersionString: truncate(device?.sw_version || VERSION, 64),
                    hardwareVersionString: truncate(device?.hw_version || "1.0", 64),
                    reachable: entity.state !== "unavailable",
                },
            } as any);
            await this.aggregator.add(endpoint);
            mapper.attach?.(endpoint, context);
            // Persisted Matter state may be outdated - always apply the current Home Assistant state
            if (entity.state !== "unavailable") await this.#applyState(endpoint, mapper.update(entity, context));
            this.devices.set(entityId, {
                entityId,
                endpoint,
                mapper,
                signature: mapper.signature(entity),
                context,
                name,
                settingsKey: this.#settingsKey(entityId),
            });
            this.#lastErrors.delete(entityId);
            if (entity.state !== "unavailable") this.store.cacheAttributes(entityId, mapper.signature(entity), entity.attributes);
            log.info(`Added ${entityId} as "${mapper.label}"`);
        } catch (e) {
            context.camera?.stop();
            unregisterContext(endpointId);
            const message = e instanceof Error ? e.message : String(e);
            this.#lastErrors.set(entityId, message);
            log.error(`Could not add ${entityId} as ${mapper.id}: ${message}`);
            log.debug("Details", e);
        }
    }

    async #remove(device: BridgedDevice) {
        this.devices.delete(device.entityId);
        try {
            await device.endpoint.delete();
        } catch (e) {
            log.warn(`Could not remove ${device.entityId}`, e);
        }
        device.context.camera?.stop();
        closeCameraSessions(device.endpoint.id);
        unregisterContext(device.endpoint.id);
        log.info(`Removed ${device.entityId}`);
    }

    errorOf(entityId: string) {
        return this.#lastErrors.get(entityId);
    }

    async #onState(entity: HassEntity | undefined, entityId: string) {
        const device = this.devices.get(entityId);
        if (!device) {
            // A new entity might match the automatic rules
            if (entity && !this.#lastErrors.has(entityId) && this.decide(entityId).exposed) await this.sync();
            return;
        }
        const effective = this.effectiveEntity(entityId);
        if (!effective) {
            await this.#setReachable(device, false);
            return;
        }

        const signature = device.mapper.signature(effective);
        if (signature !== device.signature) {
            log.info(`Features of ${entityId} changed, rebuilding Matter device`);
            await this.#remove(device);
            await this.#add(entityId, device.mapper);
            return;
        }

        const unavailable = effective.state === "unavailable";
        if (!unavailable) this.store.cacheAttributes(entityId, signature, effective.attributes);
        await this.#setReachable(device, !unavailable);
        if (unavailable) return;

        try {
            await this.#applyState(device.endpoint, device.mapper.update(effective, device.context));
            device.mapper.react?.(effective, device.context, device.endpoint);
        } catch (e) {
            log.warn(`Could not update ${entityId}: ${e instanceof Error ? e.message : e}`);
        }
    }

    async #applyState(endpoint: Endpoint, patch: Record<string, any>) {
        const filtered = Object.fromEntries(
            Object.entries(patch).filter(([key, value]) => value && Object.keys(value).length && key in endpoint.state),
        );
        if (Object.keys(filtered).length) await endpoint.set(filtered as any);
    }

    async #setReachable(device: BridgedDevice, reachable: boolean) {
        try {
            const current = (device.endpoint.state as any).bridgedDeviceBasicInformation?.reachable;
            if (current !== reachable) {
                await device.endpoint.set({ bridgedDeviceBasicInformation: { reachable } } as any);
            }
        } catch (e) {
            log.debug(`Could not update reachability of ${device.entityId}`, e);
        }
    }

    async #markAllUnreachable() {
        for (const device of this.devices.values()) await this.#setReachable(device, false);
    }
}
