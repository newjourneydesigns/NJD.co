// ---------------------------------------------------------------------------
// Render the WO mark to every PNG the portal needs.
//
//   node tools/icons/render.mjs
//
// The mark is assets/img/wo-mark.svg; this rasterises it with the headless
// Chromium that Playwright installs (no npm package needed — the binary alone
// can screenshot a page), because this repo has no build step and no Pillow.
// Outputs are committed; re-run only when the mark changes, and then rename
// the outputs — /assets/* is served immutable for a year.
//
// Headless Chromium keeps roughly 80px of a --window-size for browser chrome
// and refuses windows smaller than a few hundred pixels, so a 96px tile asked
// for at 96px comes back clipped. The page is therefore laid out in a window
// far bigger than any tile, with the tile pinned to the top-left corner, and
// the screenshot is cropped to the tile here. PNG row filters only ever look
// left and up, so keeping the first N rows and the first N pixels of each is
// a byte-level cut that needs no re-filtering.
//
// Home-screen icons are full-bleed and opaque on purpose: the platform masks
// them itself, so a transparent margin lands as a black frame around the art.
// The maskable variant keeps the mark inside the 80% safe zone.
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const OUT = join(ROOT, 'assets/img');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ORANGE = '#FF5100';
const WINDOW = 1200;

const orange = readFileSync(join(OUT, 'wo-mark.svg'), 'utf8');
const white = readFileSync(join(OUT, 'wo-mark-white.svg'), 'utf8');

const JOBS = [
  // name, size, background, svg, scale (mark width as a fraction of the tile)
  ['wo-mark-orange-96.png', 96, 'transparent', orange, 1],
  ['wo-mark-orange.png', 600, 'transparent', orange, 1],
  ['wo-favicon-32.png', 32, 'transparent', orange, 1],
  ['wo-app-icon-180.png', 180, ORANGE, white, 0.78],
  ['wo-app-icon-192.png', 192, ORANGE, white, 0.78],
  ['wo-app-icon-512.png', 512, ORANGE, white, 0.78],
  ['wo-app-icon-maskable-512.png', 512, ORANGE, white, 0.58],
];

const crc = (() => {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}

/** Crop a Chromium screenshot (8-bit RGB or RGBA, non-interlaced) to size×size at the origin. */
function cropPng(png, size) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0; let height = 0; let colorType = 0; let ihdr = null;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = Buffer.from(data);
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unexpected PNG shape');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!bpp) throw new Error(`unexpected colour type ${colorType}`);
  if (width < size || height < size) throw new Error('screenshot smaller than the tile');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + width * bpp;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(raw.subarray(y * stride, y * stride + 1 + size * bpp));
  }
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const work = mkdtempSync(join(tmpdir(), 'wo-icons-'));
try {
  for (const [name, size, bg, svg, scale] of JOBS) {
    const mark = Math.round(size * scale);
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;background:transparent}
      .tile{position:absolute;left:0;top:0;width:${size}px;height:${size}px;background:${bg};
            display:flex;align-items:center;justify-content:center;overflow:hidden}
      svg{width:${mark}px;height:${mark}px;display:block}
    </style></head><body><div class="tile">${svg}</div></body></html>`;
    const page = join(work, `${name}.html`);
    writeFileSync(page, html);
    const shot = join(work, name);
    execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${WINDOW},${WINDOW}`,
      `--screenshot=${shot}`,
      `file://${page}`,
    ], { stdio: 'ignore' });
    writeFileSync(join(OUT, name), cropPng(readFileSync(shot), size));
    console.log(`wrote assets/img/${name} (${size}px)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
