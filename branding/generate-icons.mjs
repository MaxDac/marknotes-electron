// Generates every raster app icon from the master SVGs in this folder.
//
// The outputs are committed, so builds need no extra tooling. To regenerate after changing an SVG:
//   npm i --no-save @resvg/resvg-js
//   node branding/generate-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, '..', 'build');
const icon = readFileSync(join(here, 'marknotes-icon.svg'), 'utf8');

const cache = new Map();
function png(size) {
  if (!cache.has(size)) {
    const resvg = new Resvg(icon, { fitTo: { mode: 'width', value: size } });
    cache.set(size, Buffer.from(resvg.render().asPng()));
  }
  return cache.get(size);
}

/** Windows .ico with PNG-compressed entries (supported since Windows Vista). */
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

/** macOS .icns with PNG entries. */
function icns(entries) {
  const chunks = entries.map(([type, size]) => {
    const data = png(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

mkdirSync(join(build, 'icons'), { recursive: true });
writeFileSync(join(build, 'icon.png'), png(1024));
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  writeFileSync(join(build, 'icons', `${size}x${size}.png`), png(size));
}
writeFileSync(join(build, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(
  join(build, 'icon.icns'),
  icns([
    ['ic11', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic13', 512],
    ['ic09', 512],
    ['ic14', 1024],
    ['ic10', 1024],
  ]),
);
console.log(`Icons written to ${build}`);
