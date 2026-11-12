const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const QRCode = require("qrcode");
const opentype = require("opentype.js");

// Every card image is 1728 x 1088 px: exactly 3.375 x 2.125 in (standard metal /
// credit-card size, 85.6 x 54 mm) at 512 DPI.
const W = 1728;
const H = 1088;
const DPI = 512;

// Back layout: the QR code on the left, and on the right a square panel (the AI art,
// or text for the QR-only layout). They never overlap, whatever the AI draws.
const QR_BOX = { left: 110, top: 224, size: 640 };
const PANEL = { left: 800, top: 110, size: 868 };

// Files we make follow one rule for the laser: dark pixels are what gets engraved.
// On black cards the engraving is the light part, so the QR plate is drawn dark with
// light squares; once engraved it reads as a normal dark-on-light code.
const qrInverted = (finish) => finish === "black";

// Inter for QR backs; Great Vibes (script) and Cormorant Garamond (serif) for guest names.
const FONT_FILES = {
  inter: (w) => `inter/files/inter-latin-${w}-normal.woff`,
  script: () => "great-vibes/files/great-vibes-latin-400-normal.woff",
  serif: () => "cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff",
};
const fonts = {};
function font(family, weight) {
  const key = `${family}-${weight}`;
  if (!fonts[key]) {
    const buf = fs.readFileSync(path.join(__dirname, "..", "node_modules", "@fontsource", FONT_FILES[family](weight)));
    fonts[key] = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return fonts[key];
}

// opentype.js's own toPathData sometimes prints a coordinate as "NaN" (seen with Great
// Vibes), which cuts the rest of the text off, so the path data is written here.
const num = (v) => v.toFixed(2);
function pathData(p) {
  return p.commands
    .map((c) => {
      if (c.type === "M" || c.type === "L") return `${c.type}${num(c.x)} ${num(c.y)}`;
      if (c.type === "Q") return `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`;
      if (c.type === "C") return `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`;
      return "Z";
    })
    .join("");
}

// Lays text out glyph by glyph (with kerning) as an SVG path, so no fonts need to be
// installed on the server. Shrinks the text until it fits maxWidth.
function textPath(text, { x, y, size, weight = 700, family = "inter", maxWidth = Infinity, anchor = "start", fill = "#000", wordSpace = 1 }) {
  const f = font(family, weight);
  const advance = (g, scale) => g.advanceWidth * scale * (g.unicode === 32 ? wordSpace : 1);
  const measure = (s) => {
    const scale = s / f.unitsPerEm;
    let w = 0;
    let prev = null;
    for (const ch of text) {
      const g = f.charToGlyph(ch);
      if (prev) w += f.getKerningValue(prev, g) * scale;
      w += advance(g, scale);
      prev = g;
    }
    return w;
  };
  let s = size;
  while (s > 18 && measure(s) > maxWidth) s -= 2;
  const width = measure(s);
  let cx = anchor === "middle" ? x - width / 2 : x;
  const scale = s / f.unitsPerEm;
  let d = "";
  let prev = null;
  for (const ch of text) {
    const g = f.charToGlyph(ch);
    if (prev) cx += f.getKerningValue(prev, g) * scale;
    d += pathData(g.getPath(cx, y, s));
    cx += advance(g, scale);
    prev = g;
  }
  return `<path d="${d}" fill="${fill}"/>`;
}

function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".") || s.length > 300) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function qrSvg(url, finish, { left, top, size }) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "Q" });
  const n = qr.modules.size;
  const quiet = 4;
  const cell = size / (n + quiet * 2);
  const [plate, dot] = qrInverted(finish) ? ["#000", "#fff"] : ["#fff", "#000"];
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        const x = left + (c + quiet) * cell;
        const y = top + (r + quiet) * cell;
        // Slight overlap so neighboring squares merge without hairline gaps.
        rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(cell + 0.6).toFixed(2)}" height="${(cell + 0.6).toFixed(2)}"/>`;
      }
    }
  }
  return `<rect x="${left}" y="${top}" width="${size}" height="${size}" fill="${plate}"/><g fill="${dot}" shape-rendering="crispEdges">${rects}</g>`;
}

// Stamp the JPEG with its real print resolution so laser software imports it at 3.375 x 2.125 in.
function withDpi(jpeg, dpi = DPI) {
  const isJfif = jpeg[2] === 0xff && jpeg[3] === 0xe0 && jpeg.subarray(6, 11).toString("latin1") === "JFIF\0";
  if (isJfif) {
    const out = Buffer.from(jpeg);
    out.writeUInt8(1, 13); // density unit: dots per inch
    out.writeUInt16BE(dpi, 14);
    out.writeUInt16BE(dpi, 16);
    return out;
  }
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, dpi >> 8, dpi & 0xff, dpi >> 8, dpi & 0xff, 0x00, 0x00]);
  return Buffer.concat([jpeg.subarray(0, 2), app0, jpeg.subarray(2)]);
}

const imageMime = (buf) => (buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : "image/jpeg");

const toJpeg = async (img) => withDpi(await img.jpeg({ quality: 92 }).toBuffer());

// AI-designed back: the square AI panel on the right, the real QR code on the left.
async function backWithQr(panel, { url, finish }) {
  const art = await sharp(panel).resize(PANEL.size, PANEL.size, { fit: "contain", background: "#fff" }).toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${qrSvg(url, finish, QR_BOX)}</svg>`;
  return toJpeg(
    sharp({ create: { width: W, height: H, channels: 3, background: "#fff" } }).composite([
      { input: art, left: PANEL.left, top: PANEL.top },
      { input: Buffer.from(svg), left: 0, top: 0 },
    ])
  );
}

// QR-only back: a clean layout drawn here, no AI.
async function qrOnlyBack({ url, finish, company, caption }) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const right = { x: 800, width: 840 };
  const parts = [
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<rect x="48" y="48" width="${W - 96}" height="${H - 96}" rx="36" fill="none" stroke="#000" stroke-width="6"/>`,
    qrSvg(url, finish, QR_BOX),
    caption ? textPath(caption.toUpperCase(), { x: right.x, y: 432, size: 76, weight: 800, maxWidth: right.width }) : "",
    `<rect x="${right.x}" y="472" width="${right.width}" height="8" fill="#000"/>`,
    company ? textPath(company, { x: right.x, y: 592, size: 84, weight: 700, maxWidth: right.width }) : "",
    textPath(host, { x: right.x, y: 682, size: 54, weight: 700, maxWidth: right.width }),
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
  return toJpeg(sharp(Buffer.from(svg)));
}

// Wedding place cards: the AI leaves this middle band empty and each guest's name is
// drawn into it here. The band is wiped white first, so stray AI marks never sit under a name.
const NAME_BAND = { left: 173, top: 326, width: 1382, height: 348 };
const NAME_FONTS = {
  script: { family: "script", weight: 400, size: 230, baseline: 0.66, wordSpace: 2.2 },
  serif: { family: "serif", weight: 600, size: 170, baseline: 0.64, wordSpace: 1 },
};

const blankBand = () => `<rect x="${NAME_BAND.left}" y="${NAME_BAND.top}" width="${NAME_BAND.width}" height="${NAME_BAND.height}" fill="#fff"/>`;

// The template with the name band cleared: what the laser file for a guest list is built on.
async function placeCardTemplate(template) {
  const art = await sharp(template).resize(W, H, { fit: "fill" }).toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${blankBand()}</svg>`;
  return toJpeg(sharp(art).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]));
}

async function placeCard(template, { name, font: which }) {
  const f = NAME_FONTS[which] || NAME_FONTS.script;
  const art = await sharp(template).resize(W, H, { fit: "fill" }).toBuffer();
  const text = textPath(name, {
    x: NAME_BAND.left + NAME_BAND.width / 2,
    y: NAME_BAND.top + NAME_BAND.height * f.baseline,
    size: f.size,
    weight: f.weight,
    family: f.family,
    wordSpace: f.wordSpace,
    maxWidth: NAME_BAND.width - 60,
    anchor: "middle",
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${blankBand()}${text}</svg>`;
  return toJpeg(sharp(art).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]));
}

module.exports = { W, H, DPI, QR_BOX, NAME_FONTS, normalizeUrl, withDpi, imageMime, backWithQr, qrOnlyBack, placeCard, placeCardTemplate };
