import type { Endpoint } from "@matter/main";
import type { HomeAssistantClient } from "../ha/client.js";
import type { CameraSource } from "../camera/source.js";
import type { EntitySettings } from "../config.js";
import type { HassEntity } from "../ha/types.js";

/**
 * Runtime link between a bridged Matter endpoint and its Home Assistant entity.
 * Behaviors look this up via the endpoint id to forward Matter commands to Home Assistant.
 */
export class EntityContext {
    /** Hooks set by device mappers to translate generic commands into HA service calls */
    turnOn?: () => Promise<void>;
    turnOff?: () => Promise<void>;
    setLevel?: (level: number, transitionTenths: number | null) => Promise<void>;
    /** Momentary devices (scenes, scripts, buttons) fall back to "off" after being triggered */
    momentary = false;
    /** Code used for alarm panels / locks that require one */
    alarmCode?: string;
    /** Last seen state of event-like entities, used to detect new events */
    lastEventState?: string;
    /** Video source of camera endpoints */
    camera?: CameraSource;
    /** Per-entity settings from the web UI */
    settings: EntitySettings = {};

    constructor(
        readonly entityId: string,
        readonly ha: HomeAssistantClient,
    ) {}

    get domain() {
        return this.entityId.split(".")[0];
    }

    get entity(): HassEntity | undefined {
        return this.ha.states.get(this.entityId);
    }

    get attributes(): Record<string, any> {
        return this.entity?.attributes ?? {};
    }

    /** Calls a service for this entity. */
    async call(service: string, data: Record<string, unknown> = {}, domain = this.domain) {
        await this.ha.callService(domain, service, { entity_id: this.entityId, ...data });
    }
}

const contexts = new Map<string, EntityContext>();

export function registerContext(endpointId: string, context: EntityContext) {
    contexts.set(endpointId, context);
}

export function unregisterContext(endpointId: string) {
    contexts.delete(endpointId);
}

export function contextOf(endpoint: Endpoint): EntityContext {
    const context = contexts.get(endpoint.id);
    if (!context) throw new Error(`No Home Assistant entity registered for endpoint ${endpoint.id}`);
    return context;
}
