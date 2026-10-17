import makeMdns from "multicast-dns";
import { HOMEKIT_CATEGORIES, setupHash } from "./codes/homekit.js";
import { log } from "./log.js";

export interface HapDevice {
    /** Instance name, this is also the name Home Assistant shows in the HomeKit pairing dialog */
    name: string;
    /** HomeKit device ID (AA:BB:CC:DD:EE:FF) */
    id?: string;
    model?: string;
    category?: number;
    categoryName?: string;
    /** false = already paired with a controller (e.g. Apple Home) */
    pairable?: boolean;
    setupHash?: string;
    transport: "IP" | "Thread";
    /** true when the setup hash matches the scanned QR code */
    matches?: boolean;
}

const SERVICES = { "_hap._tcp.local": "IP", "_hap._udp.local": "Thread" } as const;

/**
 * Browses the local network for HomeKit accessories (_hap._tcp for Wi-Fi/Ethernet, _hap._udp for Thread devices
 * published by a border router). Bluetooth-only accessories are not visible here - Home Assistant finds them itself.
 */
export async function discoverHapDevices(seconds: number, setupId?: string): Promise<HapDevice[]> {
    const devices = new Map<string, HapDevice>();
    const txt = new Map<string, Record<string, string>>();
    let mdns: ReturnType<typeof makeMdns>;
    try {
        mdns = makeMdns({ reuseAddr: true, loopback: process.env.MDNS_LOOPBACK === "1" });
    } catch (e) {
        log.warn("mDNS not available", e);
        return [];
    }

    const handle = (records: any[]) => {
        for (const rr of records ?? []) {
            const service = (Object.keys(SERVICES) as (keyof typeof SERVICES)[]).find(s =>
                String(rr.name).toLowerCase().endsWith(s),
            );
            if (rr.type === "PTR" && service && String(rr.name).toLowerCase() === service) {
                const instance = String(rr.data);
                if (!devices.has(instance))
                    devices.set(instance, {
                        name: instance.slice(0, instance.length - service.length - 1).replace(/\\(.)/g, "$1"),
                        transport: SERVICES[service],
                    });
            } else if (rr.type === "TXT" && service) {
                const entries: Record<string, string> = {};
                for (const buffer of Array.isArray(rr.data) ? rr.data : [rr.data]) {
                    const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
                    const index = text.indexOf("=");
                    if (index > 0) entries[text.slice(0, index).toLowerCase()] = text.slice(index + 1);
                }
                txt.set(String(rr.name), entries);
                if (!devices.has(String(rr.name))) {
                    const instance = String(rr.name);
                    devices.set(instance, {
                        name: instance.slice(0, instance.length - service.length - 1).replace(/\\(.)/g, "$1"),
                        transport: SERVICES[service],
                    });
                }
            }
        }
    };

    mdns.on("response", packet => handle([...(packet.answers ?? []), ...(packet.additionals ?? [])]));
    mdns.on("error", e => log.debug(`mDNS error: ${e.message}`));

    const query = () => {
        try {
            mdns.query({
                questions: [
                    { name: "_hap._tcp.local", type: "PTR" },
                    { name: "_hap._udp.local", type: "PTR" },
                    // Ask for TXT records of instances we know but have no details for yet
                    ...[...devices.keys()].filter(i => !txt.has(i)).map(name => ({ name, type: "TXT" as const })),
                ],
            });
        } catch (e) {
            log.debug("mDNS query failed", e);
        }
    };

    query();
    const timer = setInterval(query, 1000);
    await new Promise(resolve => setTimeout(resolve, Math.max(1, seconds) * 1000));
    clearInterval(timer);
    mdns.destroy();

    const result: HapDevice[] = [];
    for (const [instance, device] of devices) {
        const t = txt.get(instance) ?? {};
        device.id = t.id?.toUpperCase();
        device.model = t.md;
        if (t.ci) {
            device.category = Number(t.ci);
            device.categoryName = HOMEKIT_CATEGORIES[device.category];
        }
        if (t.sf !== undefined) device.pairable = (Number(t.sf) & 1) === 1;
        device.setupHash = t.sh;
        if (setupId && device.id && t.sh) device.matches = setupHash(setupId, device.id) === t.sh;
        result.push(device);
    }
    // Matching device first, then pairable devices, then the rest
    result.sort(
        (a, b) =>
            Number(!!b.matches) - Number(!!a.matches) ||
            Number(!!b.pairable) - Number(!!a.pairable) ||
            a.name.localeCompare(b.name),
    );
    log.debug(`mDNS: ${result.length} HomeKit device(s) found`);
    return result;
}
