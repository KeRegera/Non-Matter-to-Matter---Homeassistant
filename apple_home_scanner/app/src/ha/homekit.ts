import { formatSetupCode } from "../codes/homekit.js";
import { log } from "../log.js";
import { discoverHapDevices } from "../mdns.js";
import type { HomeAssistantClient } from "./client.js";

const HANDLER = "homekit_controller";

export interface PairRequest {
    setupCode: string;
    /** Name of the accessory as shown by Home Assistant (= mDNS instance name) */
    deviceName?: string;
    /** HomeKit device ID (AA:BB:…) if known from the network scan */
    deviceId?: string;
    /** Continue a pairing flow that is waiting for the device selection */
    flowId?: string;
}

export interface Option {
    value: string;
    label: string;
}

export type PairResult =
    | { status: "paired"; title: string }
    | { status: "choose"; flowId: string; options: Option[]; message: string }
    | { status: "error"; message: string; reason?: string; details?: string };

interface FlowResult {
    type: "form" | "create_entry" | "abort" | "menu" | "progress" | "external" | string;
    flow_id: string;
    handler?: string;
    step_id?: string;
    reason?: string;
    title?: string;
    errors?: Record<string, string> | null;
    data_schema?: any[];
    description_placeholders?: Record<string, string> | null;
}

const ERRORS: Record<string, string> = {
    authentication_error: "Der Setup-Code wurde vom Gerät abgelehnt. Bitte den Code prüfen.",
    unknown_error: "Das Gerät hat einen unbekannten Fehler gemeldet. Gerät neu starten und erneut versuchen.",
    max_peers_error:
        "Das Gerät ist noch mit einem anderen Controller gekoppelt (meist Apple Home) und nimmt keinen weiteren an. Entferne es zuerst aus der Home-App bzw. setze es zurück.",
    busy_error: "Das Gerät koppelt gerade mit einem anderen Controller. Einen Moment warten und erneut versuchen.",
    max_tries_error: "Zu viele Fehlversuche. Gerät kurz vom Strom trennen und erneut versuchen.",
    protocol_error:
        "Das Gerät befindet sich nicht im Kopplungsmodus. Kopplungsmodus am Gerät aktivieren (siehe Anleitung des Herstellers) und erneut versuchen.",
    no_devices:
        "Home Assistant findet kein ungekoppeltes HomeKit-Gerät. Ist das Gerät eingeschaltet, im selben Netzwerk und aus Apple Home entfernt?",
    already_configured: "Dieses Gerät ist bereits in Home Assistant eingerichtet.",
    already_paired:
        "Das Gerät ist noch mit einem anderen Controller gekoppelt (meist Apple Home). Entferne es zuerst aus der Home-App bzw. setze es zurück.",
    accessory_not_found_error: "Das Gerät ist nicht mehr erreichbar. Ist es eingeschaltet und in Reichweite?",
    accessory_disconnected_error: "Die Verbindung zum Gerät ist während der Kopplung abgebrochen.",
    ignored_model:
        "Home Assistant koppelt dieses Modell nicht über HomeKit, weil es eine eigene Integration dafür gibt. Bitte die passende Integration verwenden.",
    invalid_properties: "Das Gerät meldet ungültige Daten im Netzwerk. Gerät neu starten und erneut versuchen.",
    insecure_setup_code: "Der Setup-Code gilt als unsicher.",
};

function errorMessage(reason: string | undefined, placeholders?: Record<string, string> | null): string {
    if (!reason) return "Unbekannter Fehler bei der Kopplung";
    if (reason === "pairing_failed")
        return `Kopplung fehlgeschlagen${placeholders?.error ? `: ${placeholders.error}` : ""}.`;
    return ERRORS[reason] ?? `Home Assistant meldet: ${reason}${placeholders?.error ? ` (${placeholders.error})` : ""}`;
}

/** Extracts the select options of a form field from a serialized schema (several serializer formats supported). */
export function selectOptions(schema: any[] | undefined, field: string): Option[] {
    const list = Array.isArray(schema) ? schema : schema && typeof schema === "object" ? Object.values(schema) : [];
    const entry: any = list.find((s: any) => s?.name === field || s?.key === field);
    if (!entry) return [];
    const candidates = [
        entry.options,
        entry.selector?.select?.options,
        entry.enum,
        entry.values,
        entry.choices,
        entry.oneOf,
        entry.anyOf,
        entry.schema?.enum,
        entry.schema?.options,
    ];
    for (const raw of candidates) {
        const options = parseOptions(raw);
        if (options.length) return options;
    }
    return [];
}

function parseOptions(raw: unknown): Option[] {
    if (!raw || typeof raw !== "object") return [];
    if (Array.isArray(raw))
        return raw
            .map(o => {
                if (Array.isArray(o)) return { value: String(o[0]), label: String(o[1] ?? o[0]) };
                if (o && typeof o === "object") {
                    const value = (o as any).value ?? (o as any).const ?? (o as any).key;
                    if (value === undefined) return undefined;
                    return { value: String(value), label: String((o as any).label ?? (o as any).title ?? value) };
                }
                return { value: String(o), label: String(o) };
            })
            .filter((o): o is Option => !!o);
    return Object.entries(raw as Record<string, unknown>).map(([value, label]) => ({ value, label: String(label ?? value) }));
}

function brief(result: unknown) {
    try {
        return JSON.stringify(result).slice(0, 1500);
    } catch {
        return String(result);
    }
}

export class HomeKitPairing {
    constructor(
        private readonly ha: HomeAssistantClient,
        private readonly discoverySeconds = 5,
    ) {}

    async pair(request: PairRequest): Promise<PairResult> {
        const code = formatSetupCode(request.setupCode);

        // 1. Continue a flow that is waiting for the device selection
        if (request.flowId && request.deviceName) {
            return this.#selectDevice(request.flowId, request.deviceName, code, true);
        }

        // 2. Home Assistant usually already created a "discovered" flow for the accessory - use it
        const discovered = await this.#findDiscoveredFlow(request.deviceId, request.deviceName);
        if (discovered) {
            log.info(`Using discovered HomeKit flow ${discovered} for ${request.deviceName ?? request.deviceId}`);
            return this.#submitCode(discovered, code, false);
        }

        // 3. Start the regular "add integration" flow
        const started = await this.#startUserFlow();
        if ("status" in started) return started;
        const { flowId, options } = started;
        const wanted = request.deviceName ? options.find(o => o.value === request.deviceName) : undefined;
        if (wanted) return this.#selectDevice(flowId, wanted.value, code, true);

        return {
            status: "choose",
            flowId,
            options,
            message: request.deviceName
                ? `Home Assistant hat "${request.deviceName}" nicht in der Liste. Bitte das Gerät auswählen:`
                : "Welches Gerät gehört zu diesem Code?",
        };
    }

    /**
     * Adds an accessory using nothing but its HomeKit setup code.
     * With a QR code (setup ID) the accessory is identified on the network by its setup hash.
     * With only the 8-digit code every pairable accessory is tried in turn: the code is unique per device,
     * so all other accessories simply reject it and stay untouched.
     */
    async autoPair(setupCode: string, setupId?: string): Promise<PairResult> {
        const code = formatSetupCode(setupCode);
        const network = await discoverHapDevices(this.discoverySeconds, setupId);
        const match = network.find(d => d.matches);

        if (match) {
            log.info(`Setup ID ${setupId} belongs to "${match.name}"`);
            if (match.pairable === false)
                return {
                    status: "error",
                    reason: "already_paired",
                    message: `„${match.name}“ ist noch mit einem anderen Controller gekoppelt (meist Apple Home). Entferne es zuerst aus der Home-App bzw. setze es zurück und versuche es dann erneut.`,
                };
            const result = await this.pair({ setupCode: code, deviceName: match.name, deviceId: match.id });
            if (result.status !== "choose") return result;
            await this.cancel(result.flowId);
        }

        const started = await this.#startUserFlow();
        if ("status" in started) {
            const paired = network.filter(d => d.pairable === false).map(d => d.name);
            if (started.reason === "no_devices" && paired.length)
                started.message += ` Bereits gekoppelt (z. B. mit Apple Home): ${paired.slice(0, 8).join(", ")}.`;
            return started;
        }

        // Most likely candidates first: matching network device, then devices we also see on the network
        const seen = new Set(network.filter(d => d.pairable !== false).map(d => d.name));
        const names = started.options
            .map(o => o.value)
            .sort((a, b) => Number(b === match?.name) - Number(a === match?.name) || Number(seen.has(b)) - Number(seen.has(a)))
            .slice(0, 12);
        log.info(`Trying the setup code on ${names.length} pairable HomeKit device(s): ${names.join(", ")}`);

        let flowId: string | undefined = started.flowId;
        const failures: { name: string; result: Extract<PairResult, { status: "error" }> }[] = [];
        for (const name of names) {
            if (!flowId) {
                const next = await this.#startUserFlow();
                if ("status" in next) break;
                flowId = next.flowId;
            }
            const result = await this.#selectDevice(flowId, name, code, true);
            flowId = undefined;
            if (result.status === "paired") return result;
            if (result.status === "error") {
                log.info(`"${name}": ${result.reason ?? result.message}`);
                failures.push({ name, result });
            }
        }
        if (flowId) await this.cancel(flowId);

        const other = failures.find(f => f.result.reason !== "authentication_error");
        if (!failures.length)
            return { status: "error", message: "Home Assistant hat kein koppelbares HomeKit-Gerät gefunden." };
        if (!other)
            return {
                status: "error",
                reason: "authentication_error",
                message: `Keines der ${failures.length} koppelbaren HomeKit-Geräte (${failures.map(f => f.name).join(", ")}) hat diesen Code akzeptiert. Bitte den Code prüfen und sicherstellen, dass das Gerät aus Apple Home entfernt und eingeschaltet ist.`,
            };
        return { ...other.result, message: `${other.name}: ${other.result.message}` };
    }

    /** Starts the "add HomeKit device" flow and returns the pairable accessories Home Assistant offers */
    async #startUserFlow(): Promise<{ flowId: string; options: Option[] } | Extract<PairResult, { status: "error" }>> {
        const start = await this.ha.rest<FlowResult>("POST", "config/config_entries/flow", {
            handler: HANDLER,
            show_advanced_options: false,
        });
        log.debug(`HomeKit flow started: ${brief(start)}`);
        if (start.type === "abort")
            return { status: "error", reason: start.reason, message: errorMessage(start.reason), details: brief(start) };
        if (start.type !== "form" || start.step_id !== "user") {
            const result = await this.#unexpected(start, true);
            return result as Extract<PairResult, { status: "error" }>;
        }
        let options = selectOptions(start.data_schema, "device");
        if (!options.length) {
            // Unknown schema format: fall back to the pairable accessories we see on the network ourselves.
            // Their mDNS names are exactly the names Home Assistant uses as option values.
            log.warn(`Could not read the device list from Home Assistant: ${brief(start.data_schema)}`);
            options = (await discoverHapDevices(3))
                .filter(d => d.pairable !== false)
                .map(d => ({ value: d.name, label: d.categoryName ? `${d.name} (${d.categoryName})` : d.name }));
        }
        if (!options.length) {
            await this.cancel(start.flow_id);
            return {
                status: "error",
                reason: "no_devices",
                message:
                    "Home Assistant hat kein koppelbares HomeKit-Gerät gefunden. Ist das Gerät eingeschaltet, im selben Netzwerk und aus Apple Home entfernt (bzw. zurückgesetzt)?",
                details: brief(start),
            };
        }
        return { flowId: start.flow_id, options };
    }

    /** Cancels a pairing flow the user abandoned in the device selection */
    async cancel(flowId: string) {
        await this.ha.rest("DELETE", `config/config_entries/flow/${encodeURIComponent(flowId)}`).catch(() => undefined);
    }

    async #findDiscoveredFlow(deviceId?: string, deviceName?: string): Promise<string | undefined> {
        if (!deviceId && !deviceName) return undefined;
        let flows: any[] = [];
        try {
            flows = await this.ha.request<any[]>({ type: "config_entries/flow/progress" });
        } catch (e) {
            log.debug("Could not list config flows", e);
            return undefined;
        }
        const candidates = flows.filter(
            f =>
                f.handler === HANDLER &&
                ((deviceId && String(f.context?.unique_id ?? "").toLowerCase() === deviceId.toLowerCase()) ||
                    (deviceName && f.context?.title_placeholders?.name === deviceName)),
        );
        for (const flow of candidates) {
            try {
                const current = await this.ha.rest<FlowResult>(
                    "GET",
                    `config/config_entries/flow/${encodeURIComponent(flow.flow_id)}`,
                );
                if (current.type === "form" && current.step_id === "pair") return flow.flow_id;
            } catch (e) {
                log.debug(`Flow ${flow.flow_id} not usable`, e);
            }
        }
        return undefined;
    }

    async #selectDevice(flowId: string, deviceName: string, code: string, owned: boolean): Promise<PairResult> {
        const result = await this.ha.rest<FlowResult>("POST", `config/config_entries/flow/${encodeURIComponent(flowId)}`, {
            device: deviceName,
        });
        if (result.type === "abort" && result.reason === "already_in_progress") {
            // A discovered flow exists for this device after all - continue there
            const discovered = await this.#findDiscoveredFlow(undefined, deviceName);
            if (discovered) return this.#submitCode(discovered, code, false);
        }
        if (result.type === "abort")
            return {
                status: "error",
                reason: result.reason,
                message: errorMessage(result.reason, result.description_placeholders),
                details: brief(result),
            };
        if (result.type === "form" && result.step_id === "pair") return this.#submitCode(result.flow_id, code, owned);
        return this.#unexpected(result, owned);
    }

    async #submitCode(
        flowId: string,
        code: string,
        owned: boolean,
        allowInsecure = false,
        attempt = 0,
    ): Promise<PairResult> {
        log.info(`Sending HomeKit setup code to flow ${flowId}`);
        const body: Record<string, unknown> = { pairing_code: code };
        if (allowInsecure) body.allow_insecure_setup_codes = true;
        const result = await this.ha.rest<FlowResult>(
            "POST",
            `config/config_entries/flow/${encodeURIComponent(flowId)}`,
            body,
            180_000,
        );
        log.debug(`HomeKit flow ${flowId} answered: ${brief(result)}`);

        if (result.type === "create_entry") {
            log.info(`HomeKit device paired: ${result.title}`);
            return { status: "paired", title: result.title ?? "HomeKit-Gerät" };
        }
        if (result.type === "abort")
            return {
                status: "error",
                reason: result.reason,
                message: errorMessage(result.reason, result.description_placeholders),
                details: brief(result),
            };

        if (result.type === "form") {
            const error = result.errors ? Object.values(result.errors)[0] : undefined;
            // The user scanned the code printed on the device, so a "simple" code is still the right code
            if (error === "insecure_setup_code" && !allowInsecure)
                return this.#submitCode(flowId, code, owned, true, attempt);
            // A flow created by Home Assistant's own discovery only starts the pairing session when the first code
            // arrives and then shows the same form again (the code is dropped) - so the code has to be sent twice.
            if (result.step_id === "pair" && !error && attempt < 2) {
                log.info("Pairing session started, sending the setup code again");
                return this.#submitCode(flowId, code, owned, allowInsecure, attempt + 1);
            }
            if (result.step_id === "pair" && error) {
                if (owned) await this.cancel(flowId);
                return {
                    status: "error",
                    reason: error,
                    message: errorMessage(error, result.description_placeholders),
                    details: brief(result),
                };
            }
            if (["busy_error", "max_tries_error", "protocol_error"].includes(result.step_id ?? "")) {
                if (owned) await this.cancel(flowId);
                return { status: "error", reason: result.step_id, message: errorMessage(result.step_id) };
            }
        }
        return this.#unexpected(result, owned);
    }

    async #unexpected(result: FlowResult, owned: boolean): Promise<PairResult> {
        log.warn("Unexpected config flow result", result);
        if (owned && result.flow_id) await this.cancel(result.flow_id);
        return {
            status: "error",
            message: `Unerwartete Antwort von Home Assistant (${result.type}${result.step_id ? ` / ${result.step_id}` : ""}). Bitte über Einstellungen → Geräte & Dienste → HomeKit-Gerät hinzufügen versuchen.`,
            details: brief(result),
        };
    }
}
