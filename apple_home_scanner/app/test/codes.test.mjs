import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "../dist/codes/decode.js";
import { encodeHomeKitUri, parseHomeKitUri, setupHash } from "../dist/codes/homekit.js";
import { encodeManualCode, encodeMatterQr, parseManualCode, parseMatterQr } from "../dist/codes/matter.js";

test("HomeKit QR code (published example) decodes", () => {
  const p = parseHomeKitUri("X-HM://0081YCYEP3QYT");
  assert.equal(p.setupCode, "841-31-633");
  assert.equal(p.setupId, "3QYT");
  assert.equal(p.category, 8);
  assert.deepEqual(p.flags, { nfc: false, ip: true, ble: false, bit30: false });
  assert.equal(encodeHomeKitUri("84131633", "3QYT", 8, { ip: true }), "X-HM://0081YCYEP3QYT");
});

test("HomeKit round trip with BLE + NFC", () => {
  const uri = encodeHomeKitUri("031-45-154", "1QJ8", 10, { ble: true, nfc: true });
  const p = parseHomeKitUri(uri);
  assert.equal(p.setupCode, "031-45-154");
  assert.equal(p.category, 10);
  assert.ok(p.flags.ble && p.flags.nfc && !p.flags.ip);
});

test("setup hash is 4 bytes base64", () => {
  assert.match(setupHash("3QYT", "aa:bb:cc:dd:ee:ff"), /^[A-Za-z0-9+/]{6}==$/);
  assert.equal(setupHash("3QYT", "aa:bb:cc:dd:ee:ff"), setupHash("3QYT", "AA:BB:CC:DD:EE:FF"));
});

test("Matter test vectors (CHIP reference device)", () => {
  const p = parseMatterQr("MT:Y.K9042C00KA0648G00");
  assert.equal(p.vendorId, 0xfff1);
  assert.equal(p.productId, 0x8000);
  assert.equal(p.discriminator, 3840);
  assert.equal(p.passcode, 20202021);
  assert.equal(p.manualCode, "34970112332");
  assert.equal(encodeMatterQr({ vendorId: 0xfff1, productId: 0x8000, discoveryCapabilities: 2, discriminator: 3840, passcode: 20202021 }), "MT:Y.K9042C00KA0648G00");
  const m = parseManualCode("3497-011-2332");
  assert.equal(m.passcode, 20202021);
  assert.equal(m.discriminator, 15);
});

test("Matter 21-digit code round trip", () => {
  const code = encodeManualCode({ discriminator: 3840, passcode: 20202021, commissioningFlow: 2, vendorId: 65521, productId: 32768 });
  assert.equal(code.length, 21);
  const p = parseManualCode(code);
  assert.equal(p.vendorId, 65521);
  assert.equal(p.productId, 32768);
});

test("decode() classifies inputs", () => {
  assert.equal(decode("x-hm://0081ycyep3QYT").kind, "homekit");
  assert.equal(decode(" 841-31-633 ").homekit.setupCode, "841-31-633");
  assert.equal(decode("8413 1633").homekit.setupCode, "841-31-633");
  assert.equal(decode("mt:y.k9042c00ka0648g00").matter.manualCodeFormatted, "3497-011-2332");
  assert.throws(() => decode("34970112333"), /Prüfziffer/);
  assert.throws(() => decode("https://example.com"), /Web-Link/);
  assert.throws(() => decode("12345"), /5 Ziffern/);
});
