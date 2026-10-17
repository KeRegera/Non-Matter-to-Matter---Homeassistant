import { log } from "../log.js";
import { HomeAssistantError, type HomeAssistantClient } from "./client.js";

export type MatterStatus = "loaded" | "not_loaded" | "missing" | "unknown";

export type CommissionResult = { status: "commissioned" } | { status: "error"; message: string };

export class MatterCommissioning {
    constructor(private readonly ha: HomeAssistantClient) {}

    /** State of the Matter integration in Home Assistant */
    async status(): Promise<MatterStatus> {
        try {
            const entries = await this.ha.request<any[]>({ type: "config_entries/get", domain: "matter" });
            if (!entries.length) return "missing";
            return entries.some(e => e.state === "loaded") ? "loaded" : "not_loaded";
        } catch {
            return "unknown";
        }
    }

    /**
     * Commissions a Matter device into the Home Assistant fabric.
     * networkOnly = true: the device is already on the network (e.g. shared from Apple Home via "Turn On Pairing Mode").
     * networkOnly = false: new device, the Matter server may also use Bluetooth (needs Bluetooth + Thread/Wi-Fi credentials).
     */
    async commission(code: string, networkOnly: boolean): Promise<CommissionResult> {
        const status = await this.status();
        if (status === "missing")
            return {
                status: "error",
                message:
                    "Die Matter-Integration ist in Home Assistant nicht eingerichtet. Bitte zuerst unter Einstellungen → Geräte & Dienste die Integration „Matter“ hinzufügen.",
            };
        if (status === "not_loaded")
            return {
                status: "error",
                message: "Die Matter-Integration ist nicht geladen. Läuft der Matter-Server (Add-on „Matter Server“)?",
            };

        log.info(`Commissioning Matter device (network_only=${networkOnly})`);
        try {
            // Commissioning includes discovery, PASE, certificates and the interview - this can take a while
            await this.ha.request({ type: "matter/commission", code, network_only: networkOnly }, 300_000);
            log.info("Matter device commissioned");
            return { status: "commissioned" };
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            log.warn(`Matter commissioning failed: ${message}`);
            return { status: "error", message: explain(message, e instanceof HomeAssistantError ? e.code : undefined, networkOnly) };
        }
    }
}

function explain(message: string, code: string | undefined, networkOnly: boolean) {
    if (code === "unknown_command")
        return "Home Assistant kennt den Befehl matter/commission nicht – ist die Matter-Integration aktuell?";
    if (code === "timeout")
        return "Zeitüberschreitung: Das Gerät hat nicht rechtzeitig reagiert. Ist der Kopplungsmodus noch aktiv (Apple Home: 15 Minuten)?";
    const hints = networkOnly
        ? "Prüfe, ob der Kopplungsmodus in Apple Home noch aktiv ist und das Gerät im selben Netzwerk (bzw. Thread-Netz) wie Home Assistant erreichbar ist."
        : "Für neue Geräte braucht der Matter-Server Bluetooth sowie WLAN- bzw. Thread-Zugangsdaten. Einfacher: Gerät zuerst in Apple Home einrichten und dann per Kopplungsmodus teilen.";
    return `Kommissionierung fehlgeschlagen: ${message}. ${hints}`;
}
