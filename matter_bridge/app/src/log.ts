type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let current: Level = "info";

export function setLogLevel(level: string) {
    const normalized = level.toLowerCase();
    if (normalized === "warning") current = "warn";
    else if (normalized in order) current = normalized as Level;
}

function write(level: Level, message: string, extra: unknown[]) {
    if (order[level] < order[current]) return;
    const time = new Date().toISOString().replace("T", " ").replace("Z", "");
    const details = extra.map(e => (e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(e))).join(" ");
    const line = `${time} ${level.toUpperCase().padEnd(5)} [bridge] ${message}${details ? " " + details : ""}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
}

export const log = {
    debug: (message: string, ...extra: unknown[]) => write("debug", message, extra),
    info: (message: string, ...extra: unknown[]) => write("info", message, extra),
    warn: (message: string, ...extra: unknown[]) => write("warn", message, extra),
    error: (message: string, ...extra: unknown[]) => write("error", message, extra),
};
