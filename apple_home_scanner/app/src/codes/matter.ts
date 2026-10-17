/**
 * Matter onboarding payloads: QR code ("MT:…", base-38) and manual pairing code (11 or 21 digits).
 * Implemented after the Matter Core Specification, chapter 5.1 "Onboarding Payload".
 */

export const COMMISSIONING_FLOWS = ["Standard", "Benutzeraktion nötig", "Herstellerspezifisch"] as const;

export interface MatterPayload {
    version: number;
    vendorId?: number;
    productId?: number;
    /** 0 = standard, 1 = user intent, 2 = custom */
    commissioningFlow: number;
    /** Bitmask: 0x01 SoftAP, 0x02 BLE, 0x04 on-network, 0x08 Wi-Fi PAF, 0x10 NFC (only in QR codes) */
    discoveryCapabilities?: number;
    /** Full 12-bit discriminator (QR) or only the upper 4 bits (manual code) */
    discriminator: number;
    /** true when only the short (4-bit) discriminator is known */
    shortDiscriminator: boolean;
    passcode: number;
    qrCode?: string;
    manualCode: string;
}

const BASE38 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";

const INVALID_PASSCODES = new Set([
    0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321,
]);

// ---------- Verhoeff check digit ----------

const D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function verhoeffCheckDigit(digits: string): number {
    let c = 0;
    const reversed = digits.split("").reverse();
    for (let i = 0; i < reversed.length; i++) c = D[c][P[(i + 1) % 8][Number(reversed[i])]];
    return INV[c];
}

// ---------- Base-38 ----------

function base38Decode(text: string): Uint8Array {
    const bytes: number[] = [];
    let i = 0;
    while (i < text.length) {
        const remaining = text.length - i;
        const chars = remaining >= 5 ? 5 : remaining;
        const byteCount = chars === 5 ? 3 : chars === 4 ? 2 : chars === 2 ? 1 : -1;
        if (byteCount < 0) throw new Error("Ungültige Länge des Matter-QR-Codes");
        let value = 0;
        for (let j = chars - 1; j >= 0; j--) {
            const index = BASE38.indexOf(text[i + j]);
            if (index < 0) throw new Error(`Ungültiges Zeichen "${text[i + j]}" im Matter-QR-Code`);
            value = value * 38 + index;
        }
        if (value >= 2 ** (8 * byteCount)) throw new Error("Ungültiger Matter-QR-Code");
        for (let b = 0; b < byteCount; b++) {
            bytes.push(value & 0xff);
            value = Math.floor(value / 256);
        }
        i += chars;
    }
    return Uint8Array.from(bytes);
}

function base38Encode(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const count = Math.min(3, bytes.length - i);
        let value = 0;
        for (let b = count - 1; b >= 0; b--) value = value * 256 + bytes[i + b];
        const chars = count === 3 ? 5 : count === 2 ? 4 : 2;
        for (let c = 0; c < chars; c++) {
            out += BASE38[value % 38];
            value = Math.floor(value / 38);
        }
    }
    return out;
}

// ---------- Bit packing (little endian, LSB first) ----------

const FIELDS = [
    ["version", 3],
    ["vendorId", 16],
    ["productId", 16],
    ["commissioningFlow", 2],
    ["discoveryCapabilities", 8],
    ["discriminator", 12],
    ["passcode", 27],
] as const;

function readBits(bytes: Uint8Array) {
    let value = 0n;
    for (let i = Math.min(bytes.length, 11) - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
    const out: Record<string, number> = {};
    let offset = 0n;
    for (const [name, size] of FIELDS) {
        out[name] = Number((value >> offset) & ((1n << BigInt(size)) - 1n));
        offset += BigInt(size);
    }
    return out as Record<(typeof FIELDS)[number][0], number>;
}

function writeBits(fields: Record<(typeof FIELDS)[number][0], number>) {
    let value = 0n;
    let offset = 0n;
    for (const [name, size] of FIELDS) {
        value |= (BigInt(fields[name]) & ((1n << BigInt(size)) - 1n)) << offset;
        offset += BigInt(size);
    }
    const bytes = new Uint8Array(11);
    for (let i = 0; i < 11; i++) bytes[i] = Number((value >> BigInt(8 * i)) & 0xffn);
    return bytes;
}

// ---------- Public API ----------

export function validatePasscode(passcode: number) {
    if (!Number.isInteger(passcode) || passcode < 1 || passcode > 99_999_998 || INVALID_PASSCODES.has(passcode))
        throw new Error("Ungültiger Matter-Passcode");
}

export function parseMatterQr(input: string): MatterPayload {
    const trimmed = input.trim();
    if (!/^MT:/i.test(trimmed)) throw new Error("Kein Matter-QR-Code (muss mit MT: beginnen)");
    // A QR code may contain several payloads separated by "*" (multi-device codes) - use the first one
    const body = trimmed.slice(3).split("*")[0].toUpperCase();
    const bytes = base38Decode(body);
    if (bytes.length < 11) throw new Error("Matter-QR-Code ist zu kurz");
    const f = readBits(bytes);
    if (f.version !== 0) throw new Error(`Nicht unterstützte Matter-Payload-Version ${f.version}`);
    validatePasscode(f.passcode);
    const payload: MatterPayload = {
        version: f.version,
        vendorId: f.vendorId,
        productId: f.productId,
        commissioningFlow: f.commissioningFlow,
        discoveryCapabilities: f.discoveryCapabilities,
        discriminator: f.discriminator,
        shortDiscriminator: false,
        passcode: f.passcode,
        qrCode: `MT:${body}`,
        manualCode: "",
    };
    payload.manualCode = encodeManualCode(payload);
    return payload;
}

export function encodeMatterQr(p: {
    vendorId?: number;
    productId?: number;
    commissioningFlow?: number;
    discoveryCapabilities?: number;
    discriminator: number;
    passcode: number;
}): string {
    validatePasscode(p.passcode);
    return (
        "MT:" +
        base38Encode(
            writeBits({
                version: 0,
                vendorId: p.vendorId ?? 0,
                productId: p.productId ?? 0,
                commissioningFlow: p.commissioningFlow ?? 0,
                discoveryCapabilities: p.discoveryCapabilities ?? 0x04,
                discriminator: p.discriminator & 0xfff,
                passcode: p.passcode,
            }),
        )
    );
}

/** Creates the 11-digit (or 21-digit for custom flows) manual pairing code. */
export function encodeManualCode(p: {
    discriminator: number;
    shortDiscriminator?: boolean;
    passcode: number;
    commissioningFlow?: number;
    vendorId?: number;
    productId?: number;
}): string {
    validatePasscode(p.passcode);
    const short = p.shortDiscriminator ? p.discriminator & 0xf : (p.discriminator >> 8) & 0xf;
    const withVidPid = (p.commissioningFlow ?? 0) === 2 && p.vendorId !== undefined && p.productId !== undefined;
    let code =
        String(((withVidPid ? 1 : 0) << 2) | (short >> 2)) +
        String(((short & 0x3) << 14) | (p.passcode & 0x3fff)).padStart(5, "0") +
        String(p.passcode >> 14).padStart(4, "0");
    if (withVidPid) code += String(p.vendorId).padStart(5, "0") + String(p.productId).padStart(5, "0");
    return code + verhoeffCheckDigit(code);
}

/** Parses an 11- or 21-digit manual pairing code (dashes and spaces are ignored). */
export function parseManualCode(input: string): MatterPayload {
    const digits = input.replace(/[\s-]/g, "");
    if (!/^\d{11}$|^\d{21}$/.test(digits)) throw new Error("Ein Matter-Code hat 11 oder 21 Ziffern");
    if (verhoeffCheckDigit(digits.slice(0, -1)) !== Number(digits.at(-1)))
        throw new Error("Prüfziffer stimmt nicht – Code bitte noch einmal prüfen");
    const first = Number(digits[0]);
    if (first > 7) throw new Error("Ungültiger Matter-Code (erste Ziffer)");
    const withVidPid = !!(first & 0x4);
    if (withVidPid !== (digits.length === 21)) throw new Error("Länge passt nicht zum Code-Typ");
    const chunk2 = Number(digits.slice(1, 6));
    const chunk3 = Number(digits.slice(6, 10));
    if (chunk2 > 0xffff) throw new Error("Ungültiger Matter-Code");
    const short = ((first & 0x3) << 2) | (chunk2 >> 14);
    const passcode = (chunk3 << 14) | (chunk2 & 0x3fff);
    validatePasscode(passcode);
    const payload: MatterPayload = {
        version: 0,
        commissioningFlow: withVidPid ? 2 : 0,
        discriminator: short,
        shortDiscriminator: true,
        passcode,
        manualCode: digits,
    };
    if (withVidPid) {
        payload.vendorId = Number(digits.slice(10, 15));
        payload.productId = Number(digits.slice(15, 20));
    }
    return payload;
}

export function formatManualCode(code: string) {
    return code.length === 11
        ? `${code.slice(0, 4)}-${code.slice(4, 7)}-${code.slice(7)}`
        : `${code.slice(0, 4)}-${code.slice(4, 7)}-${code.slice(7, 11)}-${code.slice(11, 16)}-${code.slice(16)}`;
}

export function describeDiscovery(mask?: number): string[] {
    if (mask === undefined) return [];
    const out: string[] = [];
    if (mask & 0x01) out.push("SoftAP");
    if (mask & 0x02) out.push("Bluetooth LE");
    if (mask & 0x04) out.push("Im Netzwerk (WLAN/Ethernet/Thread)");
    if (mask & 0x08) out.push("Wi-Fi PAF");
    if (mask & 0x10) out.push("NFC");
    return out;
}
