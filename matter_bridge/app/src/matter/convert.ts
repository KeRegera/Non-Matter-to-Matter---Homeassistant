/** Conversion helpers between Home Assistant and Matter value ranges. */

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function num(value: unknown): number | undefined {
    if (value === null || value === undefined || value === "") return undefined;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
}

/** HA brightness (0..255) -> Matter level (1..254) */
export const brightnessToLevel = (brightness: number) => clamp(Math.round((brightness / 255) * 254), 1, 254);
/** Matter level (0..254) -> HA brightness (0..255) */
export const levelToBrightness = (level: number) => clamp(Math.round((level / 254) * 255), 0, 255);

/** HA percentage (0..100) -> Matter level (1..254) */
export const percentToLevel = (percent: number) => clamp(Math.round((percent / 100) * 254), 1, 254);
export const levelToPercent = (level: number) => clamp(Math.round((level / 254) * 100), 0, 100);

/** HA hue (0..360) -> Matter hue (0..254) */
export const hueToMatter = (hue: number) => clamp(Math.round((hue / 360) * 254), 0, 254);
export const hueFromMatter = (hue: number) => clamp((hue / 254) * 360, 0, 360);
export const enhancedHueFromMatter = (hue: number) => clamp((hue / 65535) * 360, 0, 360);
/** HA saturation (0..100) -> Matter saturation (0..254) */
export const satToMatter = (sat: number) => clamp(Math.round((sat / 100) * 254), 0, 254);
export const satFromMatter = (sat: number) => clamp((sat / 254) * 100, 0, 100);
/** CIE xy (0..1) <-> Matter (0..65279) */
export const xyToMatter = (v: number) => clamp(Math.round(v * 65536), 0, 65279);
export const xyFromMatter = (v: number) => clamp(v / 65536, 0, 1);

export const kelvinToMireds = (kelvin: number) => Math.round(1_000_000 / kelvin);
export const miredsToKelvin = (mireds: number) => Math.round(1_000_000 / mireds);

/** Matter transition time is in 1/10 s, HA in seconds */
export const transitionSeconds = (tenths: number | null | undefined) =>
    tenths === null || tenths === undefined || tenths === 0 ? undefined : tenths / 10;

/** Converts a temperature into °C */
export function toCelsius(value: number, unit: string | undefined) {
    if (unit && unit.toUpperCase().includes("F")) return ((value - 32) * 5) / 9;
    if (unit && unit.toUpperCase() === "K") return value - 273.15;
    return value;
}

export function fromCelsius(value: number, unit: string | undefined) {
    if (unit && unit.toUpperCase().includes("F")) return (value * 9) / 5 + 32;
    return value;
}

/** Converts a temperature to Matter units (0.01 °C) */
export const temperatureToMatter = (value: number, unit: string | undefined) =>
    Math.round(toCelsius(value, unit) * 100);

/** Pressure to kPa*10 (= hPa) as used by Matter PressureMeasurement */
export function pressureToMatter(value: number, unit: string | undefined): number {
    const u = (unit ?? "hPa").toLowerCase();
    let hpa = value;
    if (u === "pa") hpa = value / 100;
    else if (u === "kpa") hpa = value * 10;
    else if (u === "bar") hpa = value * 1000;
    else if (u === "cbar") hpa = value * 10;
    else if (u === "psi") hpa = value * 68.9476;
    else if (u === "inhg") hpa = value * 33.8639;
    else if (u === "mmhg") hpa = value * 1.33322;
    return Math.round(hpa);
}

/** Illuminance lux -> Matter (10000 * log10(lux) + 1) */
export const luxToMatter = (lux: number) => (lux <= 0 ? 0 : clamp(Math.round(10000 * Math.log10(lux) + 1), 1, 0xfffe));

/** Flow (m³/h) -> Matter (0.1 m³/h) */
export function flowToMatter(value: number, unit: string | undefined) {
    const u = (unit ?? "m³/h").toLowerCase();
    let m3h = value;
    if (u.includes("l/min")) m3h = (value * 60) / 1000;
    else if (u.includes("l/s")) m3h = (value * 3600) / 1000;
    else if (u.includes("gal/min")) m3h = value * 0.2271247;
    else if (u.includes("ft³/min") || u.includes("cfm")) m3h = value * 1.699011;
    return clamp(Math.round(m3h * 10), 0, 0xfffe);
}

/** Truncates a string to the byte limit allowed by Matter string attributes */
export function truncate(value: string, max = 32) {
    let result = value;
    while (Buffer.byteLength(result, "utf8") > max) result = result.slice(0, -1);
    return result;
}

export function isOn(state: string | undefined) {
    return !!state && !["off", "unavailable", "unknown", "closed", "standby"].includes(state);
}

export const isUnavailable = (state: string | undefined) => !state || state === "unavailable";
