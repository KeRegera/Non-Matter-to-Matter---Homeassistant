import { ConfigStore, loadCredentials, loadOptions } from "./config.js";
import { HomeAssistantClient } from "./ha/client.js";
import { log, setLogLevel } from "./log.js";
import { MatterBridge } from "./matter/bridge.js";
import { startWebServer } from "./web/server.js";

async function main() {
    const options = loadOptions();
    setLogLevel(options.log_level);

    const token = process.env.SUPERVISOR_TOKEN ?? process.env.HA_TOKEN;
    const url = process.env.HA_URL ?? "ws://supervisor/core/websocket";
    if (!token) {
        log.error("No SUPERVISOR_TOKEN available - is homeassistant_api enabled for the add-on?");
        process.exit(1);
    }

    const ha = new HomeAssistantClient(url, token);
    await ha.connect();

    const store = new ConfigStore();
    const bridge = new MatterBridge(options, loadCredentials(options), ha, store);
    await bridge.start();

    startWebServer(Number(process.env.INGRESS_PORT ?? 8099), bridge, ha, store);

    const shutdown = async (signal: string) => {
        log.info(`Received ${signal}, shutting down`);
        ha.close();
        await bridge.stop().catch(() => undefined);
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(e => {
    log.error("Fatal error", e);
    process.exit(1);
});
