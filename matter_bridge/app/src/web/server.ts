import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { redactUrl } from "../camera/source.js";
import type { ConfigStore, EntitySettings } from "../config.js";
import type { HomeAssistantClient } from "../ha/client.js";
import { log } from "../log.js";
import type { MatterBridge } from "../matter/bridge.js";
import { mappersForDomain, selectMapper } from "../matter/mappers.js";

/** Addresses allowed to access the UI: Home Assistant ingress proxy and localhost */
const ALLOWED = ["172.30.32.2", "127.0.0.1", "::1", "::ffff:172.30.32.2", "::ffff:127.0.0.1"];

const uiFile = join(dirname(fileURLToPath(import.meta.url)), "ui.html");

export function startWebServer(port: number, bridge: MatterBridge, ha: HomeAssistantClient, store: ConfigStore) {
    const allowAll = process.env.UI_ALLOW_ALL === "1";

    const server = createServer((req, res) => {
        const remote = req.socket.remoteAddress ?? "";
        if (!allowAll && !ALLOWED.includes(remote)) {
            res.writeHead(403).end("Forbidden");
            return;
        }
        handle(req, res).catch(e => {
            log.error("Web request failed", e);
            json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        });
    });

    async function handle(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.replace(/\/+$/, "") || "/";

        if (req.method === "GET" && (path === "/" || path === "/index.html")) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(readFileSync(uiFile));
            return;
        }

        if (req.method === "GET" && path === "/api/status") {
            const commissioning = bridge.server?.state.commissioning;
            const qr = commissioning?.pairingCodes.qrPairingCode;
            json(res, 200, {
                haConnected: ha.connected,
                running: !!bridge.server?.lifecycle.isOnline,
                commissioned: commissioning?.commissioned ?? false,
                fabrics: Object.values(commissioning?.fabrics ?? {}).map(f => ({
                    index: Number(f.fabricIndex),
                    label: f.label,
                    vendorId: Number(f.rootVendorId),
                })),
                manualPairingCode: commissioning?.pairingCodes.manualPairingCode,
                qrPairingCode: qr,
                qrSvg: qr ? await QRCode.toString(qr, { type: "svg", margin: 1, width: 220 }) : undefined,
                deviceCount: bridge.devices.size,
                port: bridge.options.port,
            });
            return;
        }

        if (req.method === "GET" && path === "/api/entities") {
            const ids = new Set([...ha.states.keys(), ...Object.keys(store.config.entities)]);
            const list = [];
            for (const entityId of [...ids].sort()) {
                const domain = entityId.split(".")[0];
                const options = mappersForDomain(domain);
                const entity = bridge.effectiveEntity(entityId);
                if (!entity) continue;
                const auto = selectMapper(entity);
                if (!options.length && !auto) continue;
                const decision = bridge.decide(entityId);
                const device = bridge.devices.get(entityId);
                const settings = store.settings(entityId);
                const area = ha.areaOf(entityId)?.name;
                list.push({
                    entityId,
                    domain,
                    name: ha.friendlyName(entityId),
                    area,
                    state: entity.state,
                    deviceClass: entity.attributes?.device_class,
                    settings: {
                        ...settings,
                        code: undefined,
                        hasCode: !!settings.code,
                        streamUrl: settings.streamUrl ? redactUrl(settings.streamUrl) : undefined,
                    },
                    exposed: !!device,
                    wanted: decision.exposed,
                    reason: decision.reason,
                    error: bridge.errorOf(entityId),
                    type: device?.mapper.id ?? decision.mapper?.id,
                    autoType: auto?.id,
                    types: (auto && !options.includes(auto) ? [auto, ...options] : options).map(m => ({
                        id: m.id,
                        label: m.label,
                    })),
                    endpoint: device ? Number(device.endpoint.number) : undefined,
                });
            }
            json(res, 200, list);
            return;
        }

        if (req.method === "POST" && path === "/api/entities") {
            const body = (await readBody(req)) as { entityIds: string[]; settings: EntitySettings };
            if (!Array.isArray(body.entityIds)) return json(res, 400, { error: "entityIds missing" });
            for (const entityId of body.entityIds) {
                if (typeof entityId !== "string" || !/^[a-z_]+\.[\w-]+$/i.test(entityId)) continue;
                const patch: EntitySettings = {};
                if ("enabled" in body.settings) patch.enabled = body.settings.enabled ?? undefined;
                if ("type" in body.settings) patch.type = body.settings.type || undefined;
                if ("name" in body.settings) patch.name = body.settings.name?.slice(0, 32) || undefined;
                if ("code" in body.settings) patch.code = body.settings.code?.slice(0, 32) || undefined;
                if ("streamUrl" in body.settings) patch.streamUrl = body.settings.streamUrl?.trim().slice(0, 500) || undefined;
                store.update(entityId, patch);
            }
            bridge.requestSync();
            await bridge.idle();
            json(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && path === "/api/factory-reset") {
            await bridge.factoryReset();
            json(res, 200, { ok: true });
            return;
        }

        json(res, 404, { error: "Not found" });
    }

    server.listen(port, () => log.info(`Web UI listening on port ${port}`));
    return server;
}

function json(res: ServerResponse, status: number, body: unknown) {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => {
            data += chunk;
            if (data.length > 1_000_000) req.destroy(new Error("Request too large"));
        });
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}
