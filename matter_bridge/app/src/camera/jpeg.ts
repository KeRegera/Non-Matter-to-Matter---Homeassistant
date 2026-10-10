/** Reads the pixel size of a JPEG image from its SOF marker */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
    let offset = 2;
    while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) {
            offset++;
            continue;
        }
        const marker = data[offset + 1];
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
        }
        const length = data.readUInt16BE(offset + 2);
        offset += 2 + length;
    }
    return undefined;
}
