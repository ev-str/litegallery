// @ts-check

/**
 * Patch or insert a JFIF density marker. Canvas encoders do not reliably retain
 * print density, while print shops commonly inspect this marker.
 * @param {Blob} jpeg
 * @param {number} ppi
 */
export async function withJpegDensity(jpeg, ppi) {
  const density = Math.max(1, Math.min(65535, Math.round(ppi)));
  const source = new Uint8Array(await jpeg.arrayBuffer());
  if (source.length < 2 || source[0] !== 0xff || source[1] !== 0xd8) throw new TypeError('not a JPEG file');
  const patched = new Uint8Array(source);
  let offset = 2;
  while (offset + 4 <= patched.length && patched[offset] === 0xff) {
    const marker = patched[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = patched[offset + 2] * 256 + patched[offset + 3];
    if (length < 2 || offset + 2 + length > patched.length) break;
    if (marker === 0xe0 && length >= 16 && isJfif(patched, offset + 4)) {
      patched[offset + 11] = 1;
      patched[offset + 12] = density >> 8;
      patched[offset + 13] = density & 0xff;
      patched[offset + 14] = density >> 8;
      patched[offset + 15] = density & 0xff;
      return new Blob([patched], {type: 'image/jpeg'});
    }
    offset += 2 + length;
  }
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x02, 0x01,
    density >> 8, density & 0xff,
    density >> 8, density & 0xff,
    0x00, 0x00,
  ]);
  const result = new Uint8Array(source.length + app0.length);
  result.set(source.subarray(0, 2), 0);
  result.set(app0, 2);
  result.set(source.subarray(2), 2 + app0.length);
  return new Blob([result], {type: 'image/jpeg'});
}

/** @param {Uint8Array} bytes @param {number} offset */
function isJfif(bytes, offset) {
  return bytes[offset] === 0x4a && bytes[offset + 1] === 0x46 && bytes[offset + 2] === 0x49 && bytes[offset + 3] === 0x46 && bytes[offset + 4] === 0;
}
