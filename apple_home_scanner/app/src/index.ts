import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HomeAssistantClient } from "./ha/client.js";
import { HomeKitPairing } from "./ha/homekit.js";
import { MatterCommissioning } from "./ha/matter.js";
import { log, setLogLevel } from "./log.js";
import { startWebServer } from "./web/server.js";

interface Options {
    log_level: string;
    discovery_seconds: number;
}

function loadOptions(): Options {
    const file = join(process.env.DATA_DIR ?? "/data", "options.json");
    let raw: Partial<Options> = {};
    try {
        if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        log.warn(`Could not read ${file}`, e);
    }
    return {
        log_level: raw.log_level ?? "info",
        discovery_seconds: Math.min(15, Math.max(2, Number(raw.discovery_seconds) || 5)),
    };
}

const options = loadOptions();
setLogLevel(options.log_level);

const token = process.env.SUPERVISOR_TOKEN ?? process.env.HA_TOKEN;
if (!token) {
    log.error("No SUPERVISOR_TOKEN available - is homeassistant_api enabled for the app?");
    process.exit(1);
}

const ha = new HomeAssistantClient(
    process.env.HA_URL ?? "ws://supervisor/core/websocket",
    process.env.HA_REST_URL ?? "http://supervisor/core/api",
    token,
);
ha.start();

startWebServer(Number(process.env.INGRESS_PORT ?? 8099), {
    ha,
    homekit: new HomeKitPairing(ha, options.discovery_seconds),
    matter: new MatterCommissioning(ha),
    discoverySeconds: options.discovery_seconds,
});

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
