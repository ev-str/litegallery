import {mkdir, rm, writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Pass an OS-temporary fixture directory as the first argument');
const root = resolve(requestedRoot);
const relativeToTemp = relative(resolve(tmpdir()), root);
if (!relativeToTemp || relativeToTemp.startsWith('..') || isAbsolute(relativeToTemp)) {
  throw new Error(`Fixture directory must be inside the OS temp directory: ${root}`);
}
const albums = [
  {name: 'Album A', count: 13, seed: 31},
  {name: 'Album B', count: 4, seed: 173},
];

await rm(root, {recursive: true, force: true});
await mkdir(root, {recursive: true});

for (const album of albums) {
  const directory = join(root, album.name);
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  for (let index = 1; index <= album.count; index += 1) {
    const color = [
      (album.seed + index * 29) % 256,
      (album.seed * 2 + index * 47) % 256,
      (album.seed * 3 + index * 61) % 256,
    ];
    const png = createSolidPng(640, 900, color);
    await writeFile(join(directory, `Photo ${String(index).padStart(2, '0')}.png`), png);
  }
}

function createSolidPng(width, height, [red, green, blue]) {
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      pixels[offset] = (red + x % 37) % 256;
      pixels[offset + 1] = (green + y % 41) % 256;
      pixels[offset + 2] = blue;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels, {level: 6})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}
