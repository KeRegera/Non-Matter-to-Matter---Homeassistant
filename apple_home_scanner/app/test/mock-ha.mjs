// Simulated Home Assistant (REST + WebSocket) for local tests of the scanner app.
// Usage: node test/mock-ha.mjs [port]
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 18124);
const flows = new Map();
let nextFlow = 1;
const DEVICES = [["Eve Energy 1A2B", "Eve Energy 1A2B (Outlet)"], ["Hue Bridge", "Hue Bridge (Bridge)"]];
// A "discovered" flow like the one Home Assistant creates via zeroconf
// Like real HA, the zeroconf flow has not started the pairing session yet: the first submitted code is dropped
flows.set("disc1", { step: "pair", device: "Nanoleaf Strip", uniqueId: "aa:bb:cc:dd:ee:ff", started: false });
// MOCK_SCHEMA=selector|none simulates other serializations of the device list
const schemaMode = process.env.MOCK_SCHEMA ?? "tuples";
const deviceSchema = () =>
  schemaMode === "selector" ? [{ name: "device", required: true, selector: { select: { options: DEVICES.map(([value, label]) => ({ value, label })) } } }]
  : schemaMode === "none" ? [{ name: "device", required: true, type: "string" }]
  : [{ name: "device", type: "select", required: true, options: DEVICES }];

const form = (id, step, extra = {}) => ({ type: "form", flow_id: id, handler: "homekit_controller", step_id: step, errors: {}, ...extra });

function flowStep(id, body) {
  const flow = flows.get(id);
  if (!flow) return [404, { message: "Flow not found" }];
  if (flow.step === "user") {
    if (!DEVICES.some(d => d[0] === body.device)) return [400, { message: "invalid device" }];
    flow.device = body.device; flow.step = "pair"; flow.started = true;
    return [200, form(id, "pair", { data_schema: [{ name: "pairing_code", type: "string", required: true }] })];
  }
  if (flow.step === "pair") {
    if (!flow.started) { flow.started = true; return [200, form(id, "pair")]; }
    const code = String(body.pairing_code ?? "");
    if (code === "123-45-678" && !body.allow_insecure_setup_codes)
      return [200, form(id, "pair", { errors: { pairing_code: "insecure_setup_code" } })];
    const CODES = { "Eve Energy 1A2B": ["841-31-633", "123-45-678"], "Hue Bridge": ["031-45-154"], "Nanoleaf Strip": ["031-45-154", "555-44-333"] };
    if ((CODES[flow.device] ?? []).includes(code)) {
      flows.delete(id);
      return [200, { type: "create_entry", flow_id: id, title: flow.device }];
    }
    if (code === "111-22-333") { flows.delete(id); return [200, { type: "abort", flow_id: id, reason: "already_paired" }]; }
    return [200, form(id, "pair", { errors: { pairing_code: "authentication_error" } })];
  }
  return [500, { message: "bad state" }];
}

const server = createServer((req, res) => {
  let data = "";
  req.on("data", c => (data += c));
  req.on("end", () => {
    const body = data ? JSON.parse(data) : {};
    const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer test") return send(401, { message: "unauthorized" });
    const m = req.url.match(/^\/api\/config\/config_entries\/flow(?:\/([^/]+))?$/);
    if (!m) return send(404, { message: "not found" });
    if (!m[1] && req.method === "POST") {
      const id = `f${nextFlow++}`;
      flows.set(id, { step: "user" });
      console.log(`[mock] flow ${id} started`);
      return send(200, form(id, "user", { data_schema: deviceSchema() }));
    }
    if (m[1] && req.method === "GET") {
      const flow = flows.get(m[1]);
      return flow ? send(200, form(m[1], flow.step)) : send(404, { message: "Flow not found" });
    }
    if (m[1] && req.method === "POST") { const [s, o] = flowStep(m[1], body); console.log(`[mock] flow ${m[1]} ->`, o.type ?? s, o.errors ?? o.reason ?? ""); return send(s, o); }
    if (m[1] && req.method === "DELETE") { flows.delete(m[1]); console.log(`[mock] flow ${m[1]} deleted`); return send(200, { message: "ok" }); }
    send(405, { message: "method" });
  });
});

const wss = new WebSocketServer({ server, path: "/api/websocket" });
wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "auth_required" }));
  ws.on("message", raw => {
    const msg = JSON.parse(raw.toString());
    const result = (success, r) => ws.send(JSON.stringify({ id: msg.id, type: "result", success, ...(success ? { result: r } : { error: r }) }));
    if (msg.type === "auth") return ws.send(JSON.stringify(msg.access_token === "test" ? { type: "auth_ok", ha_version: "2026.10.0-mock" } : { type: "auth_invalid", message: "bad" }));
    if (msg.type === "config_entries/flow/progress")
      return result(true, [...flows].filter(([, f]) => f.uniqueId).map(([id, f]) => ({ flow_id: id, handler: "homekit_controller", step_id: f.step, context: { source: "zeroconf", unique_id: f.uniqueId, title_placeholders: { name: f.device } } })));
    if (msg.type === "config_entries/get") return result(true, msg.domain === "matter" ? [{ domain: "matter", state: "loaded" }] : []);
    if (msg.type === "matter/commission") {
      console.log(`[mock] matter/commission code=${msg.code} network_only=${msg.network_only}`);
      return msg.code.includes("2332") || msg.code.startsWith("MT:")
        ? setTimeout(() => result(true, { node_id: 5 }), 300)
        : result(false, { code: "9", message: "Commission with code failed for node 6." });
    }
    result(false, { code: "unknown_command", message: "Unknown command." });
  });
});

server.listen(port, () => console.log(`[mock] Home Assistant on http://localhost:${port}`));
