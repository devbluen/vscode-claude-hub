// Gera media/icon.png (128x128) sem dependências: o mesmo desenho do activity.svg
// em branco sobre um quadrado arredondado com degradê.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SS = 4; // supersampling por eixo
const RADIUS = 28;
const FROM = [0xe0, 0x7a, 0x5f];
const TO = [0x8b, 0x5c, 0xf6];

// Desenho em coordenadas 24x24 (igual ao SVG).
const STROKE = 2.0;
const SCALE = (SIZE / 24) * 0.74;
const segments = [
  [6.3, 21.2, 6.3, 17.3], [6.3, 17.3, 10.2, 17.3],
  [17.7, 2.8, 17.7, 6.7], [17.7, 6.7, 13.8, 6.7],
  [12, 8.8, 12, 15.2], [9.2, 10.4, 14.8, 13.6], [9.2, 13.6, 14.8, 10.4],
];
const arcs = [
  { from: 0, to: 135 },
  { from: 180, to: 315 },
];

function distSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distArc(px, py, { from, to }) {
  const r = 8, cx = 12, cy = 12;
  let a = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
  if (a < 0) a += 360;
  if (a >= from && a <= to) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  const end = (deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const [ax, ay] = end(from), [bx, by] = end(to);
  return Math.min(Math.hypot(px - ax, py - ay), Math.hypot(px - bx, py - by));
}

function inGlyph(x, y) {
  const gx = (x - SIZE / 2) / SCALE + 12;
  const gy = (y - SIZE / 2) / SCALE + 12;
  const half = STROKE / 2;
  return segments.some((s) => distSegment(gx, gy, s) <= half) || arcs.some((a) => distArc(gx, gy, a) <= half);
}

function inRoundRect(x, y) {
  const r = RADIUS;
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        if (inRoundRect(px, py)) {
          bg++;
          if (inGlyph(px, py)) fg++;
        }
      }
    }
    const n = SS * SS;
    const t = (x + y) / (2 * SIZE);
    const shine = 1 + 0.12 * (1 - y / SIZE); // leve brilho no topo
    const base = FROM.map((c, i) => Math.min(255, (c + (TO[i] - c) * t) * shine));
    const f = bg ? fg / bg : 0;
    const o = (y * SIZE + x) * 4;
    for (let i = 0; i < 3; i++) pixels[o + i] = Math.round(base[i] * (1 - f) + 255 * f);
    pixels[o + 3] = Math.round((bg / n) * 255);
  }
}

// ---- PNG ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log('icon gerado:', out);
