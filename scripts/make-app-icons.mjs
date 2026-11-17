// Full-bleed icons, drawn directly as PNGs. Run: node scripts/make-app-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, checksum]);
}
for (const size of [180, 192, 512]) {
  const pixels = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    // A desktop outline and its stand, within the maskable safe area.
    const screen = u >= .25 && u <= .75 && v >= .28 && v <= .65;
    const inside = u > .29 && u < .71 && v > .32 && v < .61;
    const stand = (u >= .48 && u <= .52 && v >= .65 && v <= .72) ||
      (u >= .38 && u <= .62 && v >= .71 && v <= .75);
    const white = (screen && !inside) || stand;
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    pixels.set(white ? [255, 255, 255] : [36, 88, 198], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  writeFileSync(new URL(`../app/icon-${size}.png`, import.meta.url), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
  ]));
}
