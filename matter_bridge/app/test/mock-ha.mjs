// Minimal Home Assistant WebSocket API mock for local development and tests.
// Usage: node test/mock-ha.mjs [port]
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 8123);
const s = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes: { friendly_name: entity_id, ...attributes } });

export const states = [
    s("light.color", "on", { supported_color_modes: ["color_temp", "hs"], color_mode: "hs", brightness: 128, hs_color: [120, 50], xy_color: [0.3, 0.5], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500, effect_list: ["colorloop", "None"], supported_features: 44 }),
    s("light.ct", "on", { supported_color_modes: ["color_temp"], color_mode: "color_temp", brightness: 200, color_temp_kelvin: 3000, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 }),
    s("light.dim", "off", { supported_color_modes: ["brightness"] }),
    s("light.onoff", "on", { supported_color_modes: ["onoff"], color_mode: "onoff" }),
    s("switch.plug", "off"),
    s("input_boolean.flag", "on"),
    s("scene.movie", "2024-01-01T00:00:00"),
    s("script.hello", "off"),
    s("fan.ceiling", "on", { supported_features: 1 | 2 | 4 | 8 | 16, percentage: 50, percentage_step: 25, oscillating: true, direction: "forward", preset_modes: ["auto", "sleep"], preset_mode: null }),
    s("fan.simple", "off", { supported_features: 16 }),
    s("cover.blind", "open", { supported_features: 255, current_position: 70, current_tilt_position: 30, device_class: "blind" }),
    s("cover.garage", "closed", { supported_features: 3, device_class: "garage" }),
    s("lock.front", "locked", { supported_features: 1 }),
    s("climate.ac", "heat_cool", { hvac_modes: ["off", "heat", "cool", "heat_cool", "dry", "fan_only"], min_temp: 7, max_temp: 35, current_temperature: 21.5, target_temp_low: 20, target_temp_high: 24, fan_modes: ["auto", "low", "medium", "high"], fan_mode: "low", current_humidity: 45, hvac_action: "heating", supported_features: 1 | 2 | 8 | 16 }),
    s("climate.trv", "heat", { hvac_modes: ["off", "heat", "auto"], min_temp: 5, max_temp: 30, current_temperature: 19, temperature: 21, hvac_action: "idle" }),
    s("water_heater.boiler", "eco", { min_temp: 30, max_temp: 70, temperature: 55, current_temperature: 50, operation_list: ["off", "eco", "performance"], operation_mode: "eco" }),
    s("sensor.temp", "21.3", { device_class: "temperature", unit_of_measurement: "°C" }),
    s("sensor.temp_f", "70.1", { device_class: "temperature", unit_of_measurement: "°F" }),
    s("sensor.hum", "55.2", { device_class: "humidity", unit_of_measurement: "%" }),
    s("sensor.lux", "350", { device_class: "illuminance", unit_of_measurement: "lx" }),
    s("sensor.pressure", "1013.2", { device_class: "atmospheric_pressure", unit_of_measurement: "hPa" }),
    s("sensor.co2", "850", { device_class: "carbon_dioxide", unit_of_measurement: "ppm" }),
    s("sensor.pm25", "12", { device_class: "pm25", unit_of_measurement: "µg/m³" }),
    s("sensor.aqi", "42", { device_class: "aqi" }),
    s("sensor.flow", "12", { device_class: "volume_flow_rate", unit_of_measurement: "L/min" }),
    s("binary_sensor.door", "off", { device_class: "door" }),
    s("binary_sensor.motion", "on", { device_class: "motion" }),
    s("binary_sensor.leak", "off", { device_class: "moisture" }),
    s("binary_sensor.smoke", "off", { device_class: "smoke" }),
    s("binary_sensor.co", "off", { device_class: "carbon_monoxide" }),
    s("binary_sensor.frost", "off", { device_class: "cold" }),
    s("select.mode", "b", { options: ["a", "b", "c"] }),
    s("input_select.scene", "Day", { options: ["Day", "Night"] }),
    s("vacuum.robo", "docked", { supported_features: 16383, fan_speed_list: ["quiet", "standard", "turbo"], fan_speed: "standard" }),
    s("valve.water", "closed", { supported_features: 15, current_position: 0 }),
    s("media_player.tv", "playing", { supported_features: 0xffff, volume_level: 0.3, is_volume_muted: false, source_list: ["HDMI 1", "TV"], source: "TV" }),
    s("alarm_control_panel.home", "disarmed", { supported_features: 3 }),
    s("person.me", "home"),
    s("input_number.level", "30", { min: 0, max: 100, step: 1 }),
    s("light.offline", "unavailable", {}),
];

const map = new Map(states.map(e => [e.entity_id, e]));
export const calls = [];

const wss = new WebSocketServer({ port });
wss.on("connection", ws => {
    const send = m => ws.send(JSON.stringify(m));
    const subs = [];
    send({ type: "auth_required", ha_version: "mock" });
    ws.on("message", raw => {
        const m = JSON.parse(raw.toString());
        const ok = result => send({ id: m.id, type: "result", success: true, result });
        switch (m.type) {
            case "auth": return send({ type: "auth_ok", ha_version: "2026.10.0" });
            case "get_config": return ok({ unit_system: { temperature: "°C" } });
            case "config/entity_registry/list": return ok([...map.keys()].map(id => ({ entity_id: id, name: null, device_id: id === "light.color" ? "dev1" : null, area_id: null, labels: [], disabled_by: null, hidden_by: null, entity_category: null, platform: "mock" })));
            case "config/device_registry/list": return ok([{ id: "dev1", name: "Bulb", name_by_user: null, manufacturer: "Signify", model: "Hue Color", sw_version: "1.2", hw_version: null, area_id: "living", labels: [] }]);
            case "config/area_registry/list": return ok([{ area_id: "living", name: "Wohnzimmer" }]);
            case "config/label_registry/list": return ok([]);
            case "get_states": return ok([...map.values()]);
            case "subscribe_events": subs.push(m.id); return ok(null);
            case "call_service": {
                calls.push(m);
                console.log(`CALL ${m.domain}.${m.service} ${JSON.stringify(m.service_data)}`);
                ok({ context: {} });
                const id = m.service_data.entity_id;
                const e = map.get(id);
                if (e) {
                    const n = structuredClone(e);
                    if (m.service === "turn_on") n.state = "on";
                    if (m.service === "turn_off") n.state = "off";
                    if (m.service === "lock") n.state = "locked";
                    if (m.service === "unlock") n.state = "unlocked";
                    if (m.service_data.brightness !== undefined) n.attributes.brightness = m.service_data.brightness;
                    if (m.service === "set_percentage") { n.attributes.percentage = m.service_data.percentage; n.state = m.service_data.percentage ? "on" : "off"; }
                    if (m.service === "set_hvac_mode") n.state = m.service_data.hvac_mode;
                    if (m.service === "set_temperature") Object.assign(n.attributes, Object.fromEntries(Object.entries(m.service_data).filter(([k]) => k !== "entity_id")));
                    if (m.service === "set_cover_position") n.attributes.current_position = m.service_data.position;
                    if (m.service === "select_option") n.state = m.service_data.option;
                    map.set(id, n);
                    for (const sub of subs) send({ id: sub, type: "event", event: { event_type: "state_changed", data: { entity_id: id, old_state: e, new_state: n } } });
                }
                return;
            }
            default: return send({ id: m.id, type: "result", success: false, error: { code: "unknown_command", message: m.type } });
        }
    });
});
console.log(`Mock Home Assistant listening on ws://localhost:${port}`);
