const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const QRCode = require("qrcode");
const opentype = require("opentype.js");

// Every card image is 1792 x 1024 px: exactly 3.5 x 2 in at 512 DPI.
const W = 1792;
const H = 1024;
const DPI = 512;

// Back layout: the QR code on the left, and on the right a square panel (the AI art,
// or text for the QR-only layout). They never overlap, whatever the AI draws.
const QR_BOX = { left: 120, top: 192, size: 640 };
const PANEL = { left: 836, top: 62, size: 900 };

// Files we make follow one rule for the laser: dark pixels are what gets engraved.
// On black cards the engraving is the light part, so the QR plate is drawn dark with
// light squares; once engraved it reads as a normal dark-on-light code.
const qrInverted = (finish) => finish === "black";

const fonts = {};
function font(weight) {
  if (!fonts[weight]) {
    const file = path.join(__dirname, "..", "node_modules", "@fontsource", "inter", "files", `inter-latin-${weight}-normal.woff`);
    const buf = fs.readFileSync(file);
    fonts[weight] = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return fonts[weight];
}

// Lays text out glyph by glyph (with kerning) as an SVG path, so no fonts need to be
// installed on the server. Shrinks the text until it fits maxWidth.
function textPath(text, { x, y, size, weight = 700, maxWidth = Infinity, anchor = "start", fill = "#000" }) {
  const f = font(weight);
  const measure = (s) => {
    const scale = s / f.unitsPerEm;
    let w = 0;
    let prev = null;
    for (const ch of text) {
      const g = f.charToGlyph(ch);
      if (prev) w += f.getKerningValue(prev, g) * scale;
      w += g.advanceWidth * scale;
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
    d += g.getPath(cx, y, s).toPathData(2);
    cx += g.advanceWidth * scale;
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

// Stamp the JPEG with its real print resolution so laser software imports it at 3.5 x 2 in.
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
  const right = { x: 840, width: 840 };
  const parts = [
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<rect x="48" y="48" width="${W - 96}" height="${H - 96}" rx="36" fill="none" stroke="#000" stroke-width="6"/>`,
    qrSvg(url, finish, QR_BOX),
    caption ? textPath(caption.toUpperCase(), { x: right.x, y: 400, size: 76, weight: 800, maxWidth: right.width }) : "",
    `<rect x="${right.x}" y="440" width="${right.width}" height="8" fill="#000"/>`,
    company ? textPath(company, { x: right.x, y: 560, size: 84, weight: 700, maxWidth: right.width }) : "",
    textPath(host, { x: right.x, y: 650, size: 54, weight: 700, maxWidth: right.width }),
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
  return toJpeg(sharp(Buffer.from(svg)));
}

module.exports = { W, H, DPI, QR_BOX, normalizeUrl, withDpi, imageMime, backWithQr, qrOnlyBack };
