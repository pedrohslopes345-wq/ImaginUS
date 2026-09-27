// Gera os ícones PNG (círculo com duas "ondas") sem depender de nenhuma lib.
// Uso: npm run icons
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Supersampling 4x4 para bordas suaves.
function png(size, shade) {
  const row = size * 4 + 1;
  const raw = Buffer.alloc(size * row);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const [pr, pg, pb, pa] = shade((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const i = y * row + 1 + x * 4;
      raw[i] = a ? Math.round(r / a) : 0;
      raw[i + 1] = a ? Math.round(g / a) : 0;
      raw[i + 2] = a ? Math.round(b / a) : 0;
      raw[i + 3] = Math.round(a / 16);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ACCENT = [232, 93, 117];
const WHITE = [255, 255, 255];

function shade(u, v) {
  const dx = u - 0.5, dy = v - 0.5;
  const d = Math.hypot(dx, dy);
  if (d > 0.48) return [0, 0, 0, 0];
  // ponto à esquerda e duas ondas saindo dele para a direita
  const ox = dx + 0.12;
  const fromDot = Math.hypot(ox, dy);
  const arc = (radius) => Math.abs(fromDot - radius) < 0.035 && ox > Math.abs(dy) * 0.8;
  if (fromDot < 0.08 || arc(0.18) || arc(0.3)) return [...WHITE, 255];
  return [...ACCENT, 255];
}

const out = path.join(__dirname, "..", "assets");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.png"), png(256, shade));
fs.writeFileSync(path.join(out, "tray.png"), png(32, shade));
console.log("Ícones gerados em", out);
