import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { decode } from "../codes/decode.js";
import type { HomeAssistantClient } from "../ha/client.js";
import type { HomeKitPairing } from "../ha/homekit.js";
import type { MatterCommissioning } from "../ha/matter.js";
import { log } from "../log.js";
import { discoverHapDevices } from "../mdns.js";

/** Addresses allowed to access the UI: Home Assistant ingress proxy and localhost */
const ALLOWED = ["172.30.32.2", "127.0.0.1", "::1", "::ffff:172.30.32.2", "::ffff:127.0.0.1"];

const webDir = dirname(fileURLToPath(import.meta.url));

export interface ServerDeps {
    ha: HomeAssistantClient;
    homekit: HomeKitPairing;
    matter: MatterCommissioning;
    discoverySeconds: number;
}

export function startWebServer(port: number, deps: ServerDeps) {
    const allowAll = process.env.UI_ALLOW_ALL === "1";
    const ui = readFileSync(join(webDir, "ui.html"));
    const jsqr = readFileSync(join(webDir, "jsQR.js"));

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
            res.end(ui);
            return;
        }
        if (req.method === "GET" && path === "/jsQR.js") {
            res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "max-age=86400" });
            res.end(jsqr);
            return;
        }

        if (req.method === "GET" && path === "/api/status") {
            json(res, 200, {
                haConnected: deps.ha.connected,
                haVersion: deps.ha.version,
                matter: deps.ha.connected ? await deps.matter.status() : "unknown",
            });
            return;
        }

        if (req.method === "POST" && path === "/api/decode") {
            const body = (await readBody(req)) as { text?: string };
            try {
                const result = decode(String(body.text ?? ""));
                const qrText = result.kind === "homekit" ? result.homekit.uri : result.matter.qrCode;
                json(res, 200, {
                    ...result,
                    qrSvg: qrText ? await QRCode.toString(qrText, { type: "svg", margin: 1, width: 200 }) : undefined,
                });
            } catch (e) {
                json(res, 400, { error: e instanceof Error ? e.message : String(e) });
            }
            return;
        }

        if (req.method === "POST" && path === "/api/homekit/discover") {
            const body = (await readBody(req)) as { setupId?: string };
            const setupId = typeof body.setupId === "string" && /^[0-9A-Z]{4}$/i.test(body.setupId) ? body.setupId : undefined;
            json(res, 200, { devices: await discoverHapDevices(deps.discoverySeconds, setupId) });
            return;
        }

        if (req.method === "POST" && path === "/api/homekit/pair") {
            const body = (await readBody(req)) as Record<string, unknown>;
            const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);
            const setupCode = str(body.setupCode);
            if (!setupCode) return json(res, 400, { error: "setupCode fehlt" });
            json(
                res,
                200,
                await deps.homekit.pair({
                    setupCode,
                    deviceName: str(body.deviceName),
                    deviceId: str(body.deviceId),
                    flowId: str(body.flowId),
                }),
            );
            return;
        }

        if (req.method === "POST" && path === "/api/homekit/cancel") {
            const body = (await readBody(req)) as { flowId?: string };
            if (typeof body.flowId === "string") await deps.homekit.cancel(body.flowId);
            json(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && path === "/api/matter/commission") {
            const body = (await readBody(req)) as { code?: string; networkOnly?: boolean };
            // Re-validate: only well-formed Matter codes are passed on to Home Assistant
            const decoded = decode(String(body.code ?? ""));
            if (decoded.kind !== "matter") return json(res, 400, { error: "Kein Matter-Code" });
            const code = decoded.matter.qrCode ?? decoded.matter.manualCode;
            json(res, 200, await deps.matter.commission(code, body.networkOnly !== false));
            return;
        }

        json(res, 404, { error: "Not found" });
    }

    server.on("error", (e: NodeJS.ErrnoException) => {
        log.error(e.code === "EADDRINUSE" ? `Web UI port ${port} is already in use` : `Web UI error: ${e.message}`);
        process.exit(1);
    });
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
            if (data.length > 100_000) req.destroy(new Error("Request too large"));
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
