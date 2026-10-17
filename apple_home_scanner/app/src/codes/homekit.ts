import { createHash } from "node:crypto";

/**
 * Apple HomeKit setup payload ("X-HM://…" QR code on HomeKit accessories).
 *
 * Layout (45-bit word, written as 9 base-36 digits, followed by the 4-character setup ID):
 *   bits 45-43 version, 42-39 reserved, 38-31 category,
 *   bit 30 unused, 29 BLE, 28 IP, 27 NFC, bits 26-0 setup code (8 decimal digits)
 */

export const HOMEKIT_CATEGORIES: Record<number, string> = {
    1: "Sonstiges",
    2: "Bridge",
    3: "Ventilator",
    4: "Garagentoröffner",
    5: "Lampe",
    6: "Türschloss",
    7: "Steckdose",
    8: "Schalter",
    9: "Thermostat",
    10: "Sensor",
    11: "Alarmanlage",
    12: "Tür",
    13: "Fenster",
    14: "Rollladen / Jalousie",
    15: "Programmierbarer Schalter",
    16: "Reichweitenverstärker",
    17: "IP-Kamera",
    18: "Video-Türklingel",
    19: "Luftreiniger",
    20: "Heizung",
    21: "Klimaanlage",
    22: "Luftbefeuchter",
    23: "Luftentfeuchter",
    24: "Apple TV",
    25: "HomePod",
    26: "Lautsprecher",
    27: "AirPort",
    28: "Bewässerung",
    29: "Wasserhahn",
    30: "Dusche",
    31: "Fernseher",
    32: "Fernbedienung",
    33: "WLAN-Router",
    34: "Audio-Receiver",
    35: "TV-Set-Top-Box",
    36: "TV-Streaming-Stick",
};

export interface HomeKitFlags {
    nfc: boolean;
    ip: boolean;
    ble: boolean;
    /** Bit 30 – reserved/unused according to the public documentation */
    bit30: boolean;
}

export interface HomeKitPayload {
    /** Setup code formatted as XXX-XX-XXX */
    setupCode: string;
    /** 4-character setup ID (only present in the QR code, not in the printed code) */
    setupId?: string;
    category?: number;
    categoryName?: string;
    flags?: HomeKitFlags;
    version?: number;
    /** true for codes that Home Assistant rejects unless explicitly allowed (e.g. 123-45-678) */
    insecure: boolean;
    /** Original X-HM URI, if the input was a QR code */
    uri?: string;
}

const INSECURE_CODES = new Set([
    "00000000",
    "11111111",
    "22222222",
    "33333333",
    "44444444",
    "55555555",
    "66666666",
    "77777777",
    "88888888",
    "99999999",
    "12345678",
    "87654321",
]);

const SETUP_ID = /^[0-9A-Z]{4}$/;

export function formatSetupCode(digits: string | number): string {
    const d = String(digits).replace(/\D/g, "").padStart(8, "0");
    if (d.length !== 8) throw new Error("Ein HomeKit-Code hat genau 8 Ziffern");
    return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

export function isInsecureSetupCode(code: string) {
    return INSECURE_CODES.has(code.replace(/\D/g, ""));
}

/** Parses an "X-HM://" setup URI. Throws on invalid input. */
export function parseHomeKitUri(input: string): HomeKitPayload {
    const match = /^X-HM:\/\/([0-9A-Z]{9})([0-9A-Z]{4})$/i.exec(input.trim());
    if (!match) throw new Error("Kein gültiger HomeKit-QR-Code (erwartet X-HM:// + 13 Zeichen)");
    const encoded = match[1].toUpperCase();
    // Setup IDs are case sensitive in theory, in practice always upper case on labels
    const setupId = match[2];

    let value = 0n;
    for (const char of encoded) value = value * 36n + BigInt(parseInt(char, 36));

    const codeValue = Number(value & 0x7ffffffn);
    if (codeValue > 99_999_999) throw new Error("Ungültiger Setup-Code im HomeKit-QR-Code");
    const flagBits = Number((value >> 27n) & 0xfn);
    const category = Number((value >> 31n) & 0xffn);
    const version = Number((value >> 43n) & 0x7n);
    const setupCode = formatSetupCode(codeValue);

    return {
        setupCode,
        setupId,
        category,
        categoryName: HOMEKIT_CATEGORIES[category] ?? `Unbekannt (${category})`,
        flags: {
            nfc: !!(flagBits & 0b0001),
            ip: !!(flagBits & 0b0010),
            ble: !!(flagBits & 0b0100),
            bit30: !!(flagBits & 0b1000),
        },
        version,
        insecure: isInsecureSetupCode(setupCode),
        uri: `X-HM://${encoded}${setupId}`,
    };
}

/** Builds an "X-HM://" setup URI (used for tests and to show a cleaned-up QR code). */
export function encodeHomeKitUri(
    setupCode: string,
    setupId: string,
    category: number,
    flags: Partial<HomeKitFlags> = { ip: true },
): string {
    if (!SETUP_ID.test(setupId)) throw new Error("Setup-ID muss aus 4 Zeichen (0-9, A-Z) bestehen");
    const code = BigInt(Number(setupCode.replace(/\D/g, "")));
    let flagBits = 0n;
    if (flags.nfc) flagBits |= 1n;
    if (flags.ip) flagBits |= 2n;
    if (flags.ble) flagBits |= 4n;
    if (flags.bit30) flagBits |= 8n;
    const value = code | (flagBits << 27n) | (BigInt(category & 0xff) << 31n);
    return `X-HM://${value.toString(36).toUpperCase().padStart(9, "0")}${setupId}`;
}

/** Parses a printed 8-digit HomeKit code ("123-45-678", "1234-5678", "12345678"). */
export function parseHomeKitSetupCode(input: string): HomeKitPayload | undefined {
    const trimmed = input.trim();
    if (!/^\d{3}-?\d{2}-?\d{3}$|^\d{4}[- ]\d{4}$/.test(trimmed)) return undefined;
    const setupCode = formatSetupCode(trimmed);
    return { setupCode, insecure: isInsecureSetupCode(setupCode) };
}

/**
 * Setup hash advertised by unpaired accessories (TXT record "sh" in mDNS, also in BLE adverts):
 * base64 of the first 4 bytes of SHA-512(setupID + deviceID).
 * Lets us find the accessory belonging to a scanned QR code on the network.
 */
export function setupHash(setupId: string, deviceId: string): string {
    return createHash("sha512")
        .update(setupId + deviceId.toUpperCase())
        .digest()
        .subarray(0, 4)
        .toString("base64");
}
