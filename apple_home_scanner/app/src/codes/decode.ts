import { parseHomeKitSetupCode, parseHomeKitUri, type HomeKitPayload } from "./homekit.js";
import { describeDiscovery, formatManualCode, parseManualCode, parseMatterQr, type MatterPayload } from "./matter.js";

export type Decoded =
    | { kind: "homekit"; source: "qr" | "code"; homekit: HomeKitPayload }
    | {
          kind: "matter";
          source: "qr" | "code";
          matter: MatterPayload & { manualCodeFormatted: string; discovery: string[] };
      };

/**
 * Recognizes everything that can be found in or around Apple Home:
 *  - HomeKit QR code        X-HM://0026ACH7L1A2B
 *  - HomeKit setup code     123-45-678
 *  - Matter QR code         MT:Y.K9042C00KA0648G00
 *  - Matter manual code     3497-011-2332 (also what Apple Home shows under "Turn On Pairing Mode")
 */
export function decode(raw: string): Decoded {
    const input = raw.trim().replace(/^["']|["']$/g, "");
    if (!input) throw new Error("Kein Code angegeben");

    if (/^X-HM:\/\//i.test(input)) return { kind: "homekit", source: "qr", homekit: parseHomeKitUri(input) };

    if (/^MT:/i.test(input)) return { kind: "matter", source: "qr", matter: withExtras(parseMatterQr(input)) };

    const homekit = parseHomeKitSetupCode(input);
    if (homekit) return { kind: "homekit", source: "code", homekit };

    const digits = input.replace(/[\s-]/g, "");
    if (/^\d+$/.test(digits)) {
        if (digits.length === 11 || digits.length === 21)
            return { kind: "matter", source: "code", matter: withExtras(parseManualCode(digits)) };
        throw new Error(
            `Code mit ${digits.length} Ziffern erkannt. HomeKit-Codes haben 8 Ziffern, Matter-Codes 11 oder 21 Ziffern.`,
        );
    }

    if (/^https?:\/\//i.test(input))
        throw new Error("Der QR-Code enthält einen Web-Link und keinen Kopplungscode (z. B. Hersteller-Website).");

    throw new Error("Unbekanntes Format. Erwartet wird ein HomeKit- (X-HM://…) oder Matter-Code (MT:…).");
}

function withExtras(matter: MatterPayload) {
    return {
        ...matter,
        manualCodeFormatted: formatManualCode(matter.manualCode),
        discovery: describeDiscovery(matter.discoveryCapabilities),
    };
}
