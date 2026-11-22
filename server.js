const path = require("path");
const crypto = require("crypto");
const express = require("express");
const OpenAI = require("openai");
const Stripe = require("stripe");
const catalog = require("./config/catalog");
const shipping = require("./config/shipping");
const plans = require("./config/plans");
const { pool, migrate } = require("./lib/db");
const { sendAlert, sendToCustomer } = require("./lib/mailer");
const cardback = require("./lib/cardback");
const { withDpi, imageMime, normalizeUrl } = cardback;
const { ZipWriter } = require("./lib/zip");
const sharp = require("sharp");
const { renderPreview, planPages, safeUrl, hexColor } = require("./lib/preview");
const outreach = require("./lib/outreach");
const inbox = require("./lib/inbox");
const tradeImages = require("./lib/tradeImages");
const googlePlaces = require("./lib/googlePlaces");
const businessTypes = require("./config/businessTypes");
const startExtras = require("./lib/startExtras");

const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const app = express();

// Stripe calls this when a checkout is paid. It needs the raw body to verify the
// signature, so it's registered before the JSON parser.
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    try {
      if (event.data.object.metadata?.kind === "website") await markProjectPaid(event.data.object.id);
      else await markPaid(event.data.object.id);
    } catch (err) {
      console.error("webhook markPaid failed:", err);
      return res.status(500).end(); // Stripe retries
    }
  }
  res.json({ received: true });
});

// Send page visits to the secure canonical address (https://www...). API calls and
// the Stripe webhook are left alone so nothing posted gets redirected.
const CANONICAL = new URL(SITE_URL);
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/") || CANONICAL.protocol !== "https:") return next();
  const proto = req.headers["x-forwarded-proto"];
  if (proto === "http" || req.hostname !== CANONICAL.hostname) {
    return res.redirect(301, `${CANONICAL.origin}${req.originalUrl}`);
  }
  next();
});

app.use(express.json({ limit: "8mb" }));
// Browsers ask for /favicon.ico on their own; give them the globe.
app.get("/favicon.ico", (req, res) => res.set("Cache-Control", "public, max-age=86400").type("png").sendFile(path.join(__dirname, "public", "img", "favicon-64.png")));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ---------- helpers ----------

function clean(str, max = 120) {
  return String(str || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function cardDetails(body) {
  const d = body.details || {};
  return {
    name: clean(d.name, 60),
    title: clean(d.title, 60),
    company: clean(d.company, 60),
    phone: clean(d.phone, 30),
    email: clean(d.email, 80),
    website: clean(d.website, 80),
    tagline: clean(d.tagline, 100),
  };
}

// Wedding cards: the couple's names, the date and an optional line (a thank-you, the venue...).
function weddingDetails(body) {
  const d = body.details || {};
  return { couple: clean(d.couple, 60), date: clean(d.date, 40), line: clean(d.line, 80) };
}

const isWedding = (body) => body.product === "wedding";
const detailsFor = (body) => (isWedding(body) ? weddingDetails(body) : cardDetails(body));

// One guest name per line, blank lines dropped. Returns null when the list is too short or long.
function guestList(raw) {
  const names = (Array.isArray(raw) ? raw : String(raw || "").split(/\r?\n/)).map((n) => clean(n, 60)).filter(Boolean);
  return names.length >= catalog.MIN_QTY && names.length <= catalog.MAX_QTY ? names : null;
}

const NAME_FONTS = Object.keys(cardback.NAME_FONTS);
const nameFont = (v) => (NAME_FONTS.includes(v) ? v : "script");

// Simple per-IP limit so the AI designer can't be used to run up the API bill.
const hits = new Map();
function rateLimited(ip, limit = 25, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > limit;
}

// ---------- catalog ----------

app.get("/api/catalog", (req, res) => {
  res.json({
    thickness: catalog.cardThickness,
    finish: catalog.cardFinish,
    quantity: catalog.cardQuantity,
    destinations: shipping.DESTINATIONS,
    freeUsShippingOverCents: shipping.US_FREE_OVER_CENTS,
    aiEnabled: Boolean(openai),
    checkoutEnabled: Boolean(stripe),
  });
});

// ---------- promo codes ----------

const STRIPE_MIN_CENTS = 50; // Stripe won't charge less than $0.50

async function findPromo(raw) {
  const code = clean(raw, 40).toUpperCase();
  if (!code) return { promo: null };
  const { rows } = await pool.query("SELECT * FROM promos WHERE code=$1", [code]);
  const p = rows[0];
  if (!p || !p.active) return { error: "That promo code isn't valid." };
  if (p.max_uses != null && p.uses >= p.max_uses) return { error: "That promo code has been used up." };
  return { promo: p };
}

function applyPromo(quote, promo) {
  const subtotal = quote.totalCents;
  let total = subtotal;
  if (promo?.kind === "percent") total = Math.round(subtotal * (1 - Math.min(promo.value, 100) / 100));
  if (promo?.kind === "amount") total = subtotal - promo.value;
  if (promo?.kind === "fixed_total") total = Math.min(promo.value, subtotal);
  total = Math.max(total, Math.min(STRIPE_MIN_CENTS, subtotal));
  return { subtotalCents: subtotal, discountCents: subtotal - total, totalCents: total };
}

// "0.3 mm, Gloss black, 10 cards" for a code limited to those options; "" when it fits anything.
function promoScope(p) {
  const t = catalog.cardThickness.find((x) => x.id === p.thickness);
  const f = catalog.cardFinish.find((x) => x.id === p.finish);
  return [
    p.product === "wedding" ? "wedding cards" : p.product === "business" ? "business cards" : null,
    t && `${t.id} mm`,
    f && f.label,
    p.qty && `${p.qty} cards`,
  ].filter(Boolean).join(", ");
}

function promoLabel(p) {
  if (!p) return null;
  const base = p.kind === "percent" ? `${p.value}% off` : p.kind === "amount" ? `$${(p.value / 100).toFixed(2)} off` : `Order total $${(p.value / 100).toFixed(2)}`;
  const scope = promoScope(p);
  return scope ? `${base} (${scope})` : base;
}

// Why a code doesn't fit this order, or null when it does.
function promoMismatch(p, quote, product) {
  if ((p.product && p.product !== product) || (p.thickness && p.thickness !== quote.thickness.id) || (p.finish && p.finish !== quote.finish.id) || (p.qty && p.qty !== quote.qty)) {
    return `Promo ${p.code} is only for ${promoScope(p)}.`;
  }
  return null;
}

// Finds the code and checks it against this order.
async function promoFor(raw, quote, product) {
  const { promo, error } = await findPromo(raw);
  if (error || !promo) return { promo: null, error };
  const mismatch = promoMismatch(promo, quote, product);
  return mismatch ? { promo: null, error: mismatch } : { promo };
}
const productOf = (body) => (isWedding(body) ? "wedding" : "business");

// A "set the total" promo (like the $1 test code) covers shipping too.
function quoteShip(dest, quote, price, promo) {
  return shipping.quoteShipping({
    dest: String(dest),
    thickness: quote.thickness.id,
    qty: quote.qty,
    cardsTotalCents: price.totalCents,
    waive: promo?.kind === "fixed_total",
  });
}

app.post("/api/price", async (req, res) => {
  const q = catalog.quoteCard(req.body || {});
  if (!q) return res.status(400).json({ error: "Pick a thickness, finish and quantity." });
  const { promo, error } = await promoFor(req.body.promo, q, productOf(req.body));
  const price = applyPromo(q, promo);
  const ship = quoteShip(req.body.dest || "US", q, price, promo);
  res.json({
    eachCents: q.eachCents, frontCents: q.frontCents, backCents: q.backCents, ...price,
    shipping: ship, grandTotalCents: price.totalCents + (ship?.cents || 0),
    promo: promo ? { code: promo.code, label: promoLabel(promo) } : null, promoError: error || null,
  });
});

// ---------- AI business card designer (OpenAI image model) ----------

const IMAGE_MODEL = "gpt-image-2.6-flare";
const CARD_SIZE = `${cardback.W}x${cardback.H}`; // exact shape of a 3.375 x 2.125 in card
const CARD_DPI = cardback.DPI; // 1728 px / 3.375 in

// Dark pixels are what the laser engraves, so art is always dark on a light background.
const ENGRAVING_RULES = `Plain white or very light background. Draw the design in black and dark gray only, in a detailed engraved style. No color.`;

function designPrompt(details, style, hasLogo) {
  // Values are quoted with a plain description, because "Name: ..." style lines got printed
  // on cards word for word, labels and all.
  const roles = { company: "the company name", name: "the person's name", title: "their job title", tagline: "the tagline", phone: "the phone number", email: "the email address", website: "the website" };
  const text = Object.entries(roles)
    .filter(([k]) => details[k])
    .map(([k, role]) => `"${details[k]}" (${role})`)
    .join("\n");
  return `Design the FRONT of a horizontal 3.375 x 2.125 inch (credit-card size) business card that will be laser engraved on a metal card.

Fill the entire image edge to edge with the flat card design, viewed straight on. No mockup, no hands, no table, no shadows, no perspective, no card shape sitting on a background.
${ENGRAVING_RULES}

Put exactly this text on the card, spelled exactly as written, and nothing else for contact details:
${text}
Print only the text inside the quotes. The words in parentheses just explain what each line is: never print them, and never add labels like "Name:", "Company:" or "Phone:" (small phone, email and web icons are fine).

The customer's style request: ${style || "clean, modern and professional"}

Do not draw a QR code or barcode. ${hasLogo ? "Do not add any logo other than the customer's own logo described below." : "Do not use any brand logo or trademark other than this customer's own business name."} Keep all text at least 6% in from every edge so nothing is cut off.`;
}

function weddingPrompt(details, style, guestMode) {
  const text = [
    `"${details.couple}"${guestMode ? "" : " (the main, largest text)"}`,
    details.date && `"${details.date}"`,
    details.line && `"${details.line}"`,
  ].filter(Boolean).join("\n");
  return `Design a horizontal 3.375 x 2.125 inch (credit-card size) wedding ${guestMode ? "place card" : "keepsake card"} that will be laser engraved on a metal card and set on each guest's plate.

Fill the entire image edge to edge with the flat card design, viewed straight on. No mockup, no hands, no table, no plate, no shadows, no perspective, no card shape sitting on a background.
${ENGRAVING_RULES}

Put exactly these words on the card, spelled exactly as written, without the quote marks, and no other words or labels:
${text}
${guestMode ? `
IMPORTANT: each guest's name will be engraved in the middle of the card later, so leave the middle completely blank: an empty white band from 30% to 62% of the card's height, across the middle 80% of its width. Draw nothing in that band, no lines, flourishes or text. Put the words above in the lower part of the card, below the blank band, small and elegant. Decoration (a fine border, flourishes, a small ornament at the top) goes around the edges and above the band.
` : ""}
The customer's style request: ${style || "elegant and timeless, with a fine border"}

Do not draw a QR code or barcode. Do not use any brand logo or trademark. Keep all text at least 6% in from every edge so nothing is cut off.`;
}

const GUEST_BAND_RULE = "Keep the middle band (30% to 62% of the height, across the middle 80% of the width) completely blank for the guest's name.";

// The AI only draws a square panel for the right side of the back; the site puts the
// real QR code beside it (see lib/cardback.js), so the art can never cover the code.
function backPrompt(details, style, caption, fromFront, noun = "business card") {
  const name = details.couple || details.company || details.name;
  return `${fromFront ? `This image is the FRONT of a ${noun}. Use it only as a style reference (same fonts, line work and illustration style) and design` : "Design"} a SQUARE artwork panel for the back of a ${noun} that will be laser engraved on metal. A QR code will be placed to the left of this panel, so do not draw a QR code, barcode or card border.

${ENGRAVING_RULES} Fill the square edge to edge with no frame around it.
Include${caption ? ` "${caption}" as a short bold headline,` : ""} the name "${name}"${style ? `, and imagery that fits this style: ${style}` : ""}.
Spell every word exactly as written. Do not add phone numbers, emails or any other text. Keep all text at least 6% in from every edge.`;
}

// Designs take 10-60 seconds and Heroku stops any single request at 30s, so POST
// /api/design starts the work and returns a job id, and the page polls
// GET /api/design/:id until it's done. Jobs live in memory on the one dyno; finished
// designs are saved in the database so checkout can attach them to the order.
const designJobs = new Map();
const JOB_TTL_MS = 15 * 60 * 1000;

class DesignError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The customer's logo, as a PNG on white (engraving art is dark on white), at most 1024 px.
// Returns null when there's no logo, or throws a DesignError for a file we can't use.
async function logoImage(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(png|jpeg|webp);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new DesignError(400, "Your logo needs to be a PNG, JPG or WEBP image.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 6 * 1024 * 1024) throw new DesignError(400, "Your logo file is over 6 MB. Try a smaller one.");
  try {
    return await sharp(buf).flatten({ background: "#ffffff" }).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    throw new DesignError(400, "We couldn't read that logo file. Try a PNG.");
  }
}

const LOGO_RULE = (position) => `The customer's own logo is attached as the ${position} image. Put that exact logo on the card: the same shapes and the same lettering, traced faithfully, not redrawn, restyled or replaced. Show it in the single dark engraving color on the white background, at a size where its details stay clear.`;

async function runDesign({ prompt, previous, logo, size = CARD_SIZE }) {
  let result;
  const started = Date.now();
  try {
    const params = { model: IMAGE_MODEL, prompt, size, quality: "medium", output_format: "jpeg", output_compression: 90 };
    const images = [
      previous && (await OpenAI.toFile(previous, "design.jpg", { type: imageMime(previous) })),
      logo && (await OpenAI.toFile(logo, "logo.png", { type: "image/png" })),
    ].filter(Boolean);
    result = images.length
      ? await openai.images.edit({ ...params, image: images.length === 1 ? images[0] : images })
      : await openai.images.generate(params);
  } catch (err) {
    console.error("design error:", err.status, err.code, err.message);
    if (err.code === "moderation_blocked" || err.code === "content_policy_violation") {
      throw new DesignError(422, "That design request can't be made. Try describing it differently.");
    }
    if (err.status === 429) throw new DesignError(503, "The designer is busy. Try again in a minute.");
    throw new DesignError(500, "The designer hit a snag. Please try again.");
  }
  console.log(`design: ${previous ? "edit" : "new"}${logo ? " with logo" : ""} in ${((Date.now() - started) / 1000).toFixed(0)}s, usage ${JSON.stringify(result.usage)}`);

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new DesignError(500, "The designer hit a snag. Please try again.");
  const image = withDpi(Buffer.from(b64, "base64"), CARD_DPI);
  const { rows } = await pool.query("INSERT INTO designs (id, prompt, image) VALUES ($1,$2,$3) RETURNING id", [
    crypto.randomUUID(),
    prompt,
    image,
  ]);
  return { designId: rows[0].id };
}

app.post("/api/design", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "The AI designer isn't switched on yet." });
  if (rateLimited(req.ip)) return res.status(429).json({ error: "Design limit reached for now. Try again in an hour." });

  const wedding = isWedding(req.body);
  const details = detailsFor(req.body);
  if (wedding ? !details.couple : !details.name && !details.company) {
    return res.status(400).json({ error: wedding ? "Add the couple's names." : "Add at least a name or company." });
  }
  const guestMode = wedding && req.body.layout === "guest";
  const noun = wedding ? "wedding card" : "business card";
  const side = req.body.side === "back" ? "back" : "front";
  const style = clean(req.body.style, 600);
  const revision = clean(req.body.revision, 600);
  const caption = clean(req.body.caption, 60);
  const loadDesign = async (id) => {
    const { rows } = await pool.query("SELECT image FROM designs WHERE id=$1", [id]).catch(() => ({ rows: [] }));
    return rows[0]?.image || null;
  };

  let logo = null;
  try {
    // Revisions edit a design that already has the logo, so it's only sent for new designs.
    if (!(req.body.previousDesignId && revision) && !wedding) logo = await logoImage(req.body.logo);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  let previous = null;
  let prompt;
  if (req.body.previousDesignId && revision) {
    previous = await loadDesign(req.body.previousDesignId);
    if (!previous) return res.status(404).json({ error: "That design expired. Please create it again." });
    prompt = `Edit this ${noun} design. Change only what is asked and keep everything else the same: ${revision}

Keep it flat and edge to edge. ${ENGRAVING_RULES} Keep every word, number and email spelled exactly as it is now unless the change asks otherwise:
${[...Object.values(details), caption].filter(Boolean).join(" | ")}${side === "back" ? "\nKeep it a square panel with no QR code and no border." : guestMode ? `\n${GUEST_BAND_RULE}` : ""}`;
  } else if (side === "back") {
    // Base the back on the front design when there is one, so the two sides match.
    previous = req.body.frontDesignId ? await loadDesign(req.body.frontDesignId) : null;
    prompt = backPrompt(details, style, caption, Boolean(previous), noun);
  } else {
    prompt = wedding ? weddingPrompt(details, style, guestMode) : designPrompt(details, style, Boolean(logo));
  }
  if (logo) prompt += `\n\n${LOGO_RULE(previous ? "second" : "first (and only)")}`;

  for (const [id, job] of designJobs) if (Date.now() - job.createdAt > JOB_TTL_MS) designJobs.delete(id);
  const id = crypto.randomUUID();
  const job = { createdAt: Date.now(), status: "working" };
  designJobs.set(id, job);
  runDesign({ prompt, previous, logo, size: side === "back" ? "1024x1024" : CARD_SIZE }).then(
    (result) => Object.assign(job, { status: "done", result }),
    (err) => {
      if (!(err instanceof DesignError)) console.error("design save error:", err);
      Object.assign(job, { status: "error", httpStatus: err.status || 500, error: err instanceof DesignError ? err.message : "The designer hit a snag. Please try again." });
    }
  );
  res.status(202).json({ jobId: id });
});

app.get("/api/design/:id", (req, res) => {
  const job = designJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "That design expired. Please create it again." });
  if (job.status === "working") return res.json({ status: "working" });
  designJobs.delete(req.params.id);
  if (job.status === "error") return res.status(job.httpStatus).json({ error: job.error });
  res.json({ status: "done", ...job.result });
});

// Design ids are random UUIDs, so only the person who made a design can find it.
app.get("/api/design-image/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT image FROM designs WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).end();
  res.set({ "Content-Type": imageMime(rows[0].image), "Cache-Control": "private, max-age=86400" }).send(rows[0].image);
});

// A wedding place card with one guest's name drawn into the AI design's blank band.
app.get("/api/place-card-image", async (req, res) => {
  const { rows } = await pool.query("SELECT image FROM designs WHERE id=$1", [req.query.design]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).end();
  const name = clean(req.query.name, 60) || "Guest Name";
  const image = await cardback.placeCard(rows[0].image, { name, font: nameFont(req.query.font) });
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" }).send(image);
});

// The back with its real QR code, laid out for the chosen finish. With a design id it's
// the AI art plus the QR code; without one it's the clean QR-only layout.
async function buildBack({ designId, url, finish, company, caption }) {
  if (designId) {
    const { rows } = await pool.query("SELECT image FROM designs WHERE id=$1", [designId]).catch(() => ({ rows: [] }));
    if (!rows[0]) return null;
    return cardback.backWithQr(rows[0].image, { url, finish });
  }
  return cardback.qrOnlyBack({ url, finish, company, caption });
}

app.get("/api/back-image", async (req, res) => {
  const url = normalizeUrl(req.query.url);
  if (!url) return res.status(400).end();
  const finish = catalog.cardFinish.some((f) => f.id === req.query.finish) ? req.query.finish : "black";
  const image = await buildBack({
    designId: req.query.design || null,
    url,
    finish,
    company: clean(req.query.company, 60),
    caption: clean(req.query.caption, 60),
  });
  if (!image) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" }).send(image);
});

// ---------- business card checkout ----------

// Starts Stripe Checkout for a card order and saves it as pending_payment. Used by
// /api/checkout and by account reorders. Returns the Checkout URL.
async function startCardCheckout({ id, quote, price, promo, ship, dest, wedding, guests, font, details, watchLive, tiktok, notes,
                                   designType, upload, backMode, back, qrUrl, customerEmail, cancelUrl }) {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    // One line for the whole set, so a discounted total never has to split into whole cents per card.
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: price.totalCents,
          product_data: {
            name: `${quote.qty} ${wedding ? (guests ? "metal wedding place cards (one per guest)" : "metal wedding cards") : "metal business cards"} — ${quote.thickness.label}, ${quote.finish.label}${back ? ", front & back" : ""}`,
            description: [
              watchLive ? "Engraved live on TikTok" : "Custom laser engraved",
              promo ? `Promo ${promo.code}: ${promoLabel(promo)}` : null,
            ].filter(Boolean).join(" · "),
          },
        },
      },
    ],
    // Only addresses in the destination the price was quoted for.
    shipping_address_collection: { allowed_countries: [ship.country] },
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: ship.cents, currency: "usd" },
          display_name: shipping.US_STATES_BY_WEIGHT[dest] ? `${shipping.US_STATES_BY_WEIGHT[dest].name} shipping` : ship.label,
        },
      },
    ],
    ...(!shipping.isDomestic(dest)
      ? { custom_text: { shipping_address: { message: "International orders may owe import duties or taxes when they arrive. These are paid by the recipient." } } }
      : {}),
    phone_number_collection: { enabled: true },
    client_reference_id: id,
    metadata: { order_id: id, product: wedding ? "wedding" : "business", promo: promo?.code || "", thickness: quote.thickness.id, finish: quote.finish.id, qty: String(quote.qty), tiktok: tiktok },
    success_url: `${SITE_URL}/order-complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${SITE_URL}/${wedding ? "wedding-cards" : "business-cards"}`,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
  });

  await pool.query(
    `INSERT INTO orders (id, stripe_session, details, thickness, finish, qty, total_cents, watch_live, tiktok, notes,
                         design_type, upload_name, upload_mime, upload_data, promo_code, discount_cents,
                         back_mode, back_name, back_mime, back_data, qr_url, shipping_cents, ship_dest,
                         product, guest_names, name_font)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [id, session.id, details, quote.thickness.id, quote.finish.id, quote.qty, price.totalCents,
     watchLive, tiktok, notes, designType, upload.name, upload.mime, upload.data,
     promo?.code || null, price.discountCents,
     backMode, back?.name || null, back?.mime || null, back?.data || null, qrUrl || null,
     ship.cents, dest,
     wedding ? "wedding" : "business", guests ? JSON.stringify(guests) : null, guests ? font : null]
  );
  return session.url;
}

app.post("/api/checkout", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Online checkout isn't switched on yet." });
  const back = req.body.back || {};
  const backMode = ["ai", "qr", "upload"].includes(back.mode) ? back.mode : "none";
  const wedding = isWedding(req.body);
  // A guest list means one card per name, so the names set the quantity.
  let guests = null;
  if (wedding && req.body.layout === "guest") {
    guests = guestList(req.body.guests);
    if (!guests) return res.status(400).json({ error: `Add between ${catalog.MIN_QTY} and ${catalog.MAX_QTY} guest names, one per line.` });
  }
  const quote = catalog.quoteCard({ ...req.body, qty: guests ? guests.length : req.body.qty, back: backMode !== "none" });
  if (!quote) return res.status(400).json({ error: `Pick a thickness, finish and a quantity from ${catalog.MIN_QTY} to ${catalog.MAX_QTY}.` });

  const { promo, error: promoError } = await promoFor(req.body.promo, quote, wedding ? "wedding" : "business");
  if (promoError) return res.status(400).json({ error: promoError });
  const price = applyPromo(quote, promo);
  const dest = String(req.body.dest || "US");
  const ship = quoteShip(dest, quote, price, promo);
  if (!ship) return res.status(400).json({ error: "Sorry, we can't ship to that country." });

  const design = req.body.design || {};
  const order = {
    id: crypto.randomUUID(),
    details: detailsFor(req.body),
    watchLive: Boolean(req.body.watchLive),
    tiktok: clean(req.body.tiktok, 40),
    notes: clean(req.body.notes, 1000),
  };

  if (design.type === "ai") {
    const { rows } = await pool.query("SELECT image FROM designs WHERE id=$1", [design.designId]).catch(() => ({ rows: [] }));
    if (!rows[0]) return res.status(400).json({ error: "Create a design first." });
    if (guests) {
      // The laser file is the design with the name band wiped; each guest's card is built from it.
      order.upload = { mime: "image/jpeg", name: "place-card-template.jpg", data: await cardback.placeCardTemplate(rows[0].image) };
    } else {
      const mime = imageMime(rows[0].image);
      order.upload = { mime, name: mime === "image/png" ? "ai-design.png" : "ai-design.jpg", data: rows[0].image };
    }
  } else if (guests) {
    return res.status(400).json({ error: "Guest names work with the AI designer. Create your design there." });
  } else if (design.type === "upload") {
    const m = /^data:(image\/(png|jpeg|svg\+xml)|application\/pdf);base64,(.*)$/s.exec(design.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Upload a PNG, JPG, SVG or PDF." });
    order.upload = { mime: m[1], name: clean(design.name, 120), data: Buffer.from(m[3], "base64") };
  } else {
    return res.status(400).json({ error: "Create or upload a design first." });
  }

  if (backMode === "ai" || backMode === "qr") {
    order.qrUrl = normalizeUrl(back.url);
    if (!order.qrUrl) return res.status(400).json({ error: "Add the web address for the QR code on the back." });
    if (backMode === "ai" && !back.designId) return res.status(400).json({ error: "Create the back design first." });
    const data = await buildBack({
      designId: backMode === "ai" ? back.designId : null,
      url: order.qrUrl,
      finish: quote.finish.id,
      company: order.details.couple || order.details.company || order.details.name,
      caption: clean(back.caption, 60),
    });
    if (!data) return res.status(400).json({ error: "That back design expired. Please create it again." });
    order.back = { mime: "image/jpeg", name: `${backMode === "ai" ? "ai-back" : "qr-back"}.jpg`, data };
  } else if (backMode === "upload") {
    const m = /^data:(image\/(png|jpeg|svg\+xml)|application\/pdf);base64,(.*)$/s.exec(back.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Upload a PNG, JPG, SVG or PDF for the back." });
    order.back = { mime: m[1], name: clean(back.name, 120), data: Buffer.from(m[3], "base64") };
  }

  try {
    const url = await startCardCheckout({
      id: order.id, quote, price, promo, ship, dest, wedding, guests, font: nameFont(req.body.font),
      details: order.details, watchLive: order.watchLive, tiktok: order.tiktok, notes: order.notes,
      designType: design.type, upload: order.upload, backMode, back: order.back || null, qrUrl: order.qrUrl || null,
    });
    res.json({ url });
  } catch (err) {
    console.error("checkout error:", err);
    res.status(500).json({ error: "Checkout couldn't start. Please try again." });
  }
});

// Marks an order paid exactly once (Stripe webhook and the thank-you page can both
// call this), then emails the order alert with the design attached.
async function markPaid(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid") return null;
  const cust = session.customer_details || {};
  const ship = session.collected_information?.shipping_details || session.shipping_details || null;
  // Alaska and Hawaii are part of the US at Stripe, so a mainland rate with an Alaska or
  // Hawaii address can slip through. Flag it so the difference can be collected first.
  const { rows: pending } = await pool.query("SELECT ship_dest FROM orders WHERE stripe_session=$1", [sessionId]);
  const state = ship?.address?.state;
  const dest = pending[0]?.ship_dest;
  let flag = null;
  const weighted = Object.values(shipping.US_STATES_BY_WEIGHT);
  const addrState = weighted.find((w) => w.state === state);
  const paidState = shipping.US_STATES_BY_WEIGHT[dest];
  if (dest === "US" && addrState) flag = `${addrState.name} address, but paid mainland US shipping. Collect the difference before shipping.`;
  if (paidState && state && state !== paidState.state) flag = `Paid ${paidState.name} shipping, but the address is in ${state}.`;
  const { rows } = await pool.query(
    `UPDATE orders SET status='paid', paid_at=now(), customer_email=$2, customer_name=$3, customer_phone=$4, shipping=$5, ship_flag=$6
     WHERE stripe_session=$1 AND status='pending_payment' RETURNING *`,
    [sessionId, cust.email || null, ship?.name || cust.name || null, cust.phone || null, ship, flag]
  );
  if (rows[0]?.promo_code) await pool.query("UPDATE promos SET uses = uses + 1 WHERE code=$1", [rows[0].promo_code]);
  if (rows[0]) await sendOrderAlert(rows[0]).catch((e) => console.error("alert email failed:", e));
  return rows[0] || null;
}

const FINISH_LABEL = Object.fromEntries(catalog.cardFinish.map((f) => [f.id, f.label]));
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "application/pdf": "pdf" };

function designFile(order, side = "front") {
  if (side === "back") {
    if (!order.back_data) return null;
    return { filename: `EDZ-${order.id.slice(0, 8)}-BACK.${EXT[order.back_mime] || "bin"}`, contentType: order.back_mime, content: order.back_data };
  }
  const kind = order.design_type === "ai" ? "ai-design" : "upload";
  return { filename: `EDZ-${order.id.slice(0, 8)}-FRONT-${kind}.${EXT[order.upload_mime] || "bin"}`, contentType: order.upload_mime, content: order.upload_data };
}

const BACK_LABEL = { none: "blank", ai: "AI design + QR code", qr: "QR code layout", upload: "customer upload" };
const FONT_LABEL = { script: "script (Great Vibes)", serif: "serif (Cormorant Garamond)" };

function cardText(o) {
  const d = o.details || {};
  const parts = o.product === "wedding" ? [d.couple, d.date, d.line] : [d.name, d.title, d.company, d.phone, d.email, d.website, d.tagline];
  return parts.filter(Boolean).join(" | ");
}

// File-name-safe version of a guest's name for the per-card files.
const fileSafe = (s) => s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "guest";
const guestFileName = (o, i, name) => `EDZ-${o.id.slice(0, 8)}-${String(i + 1).padStart(3, "0")}-${fileSafe(name)}.jpg`;
const guestCard = (o, name) => cardback.placeCard(o.upload_data, { name, font: o.name_font });

async function sendOrderAlert(o) {
  const d = o.details || {};
  const addr = o.shipping?.address;
  const shipTo = addr ? [o.shipping.name, addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postal_code}`].filter(Boolean).join("\n") : "(none)";
  const lines = [
    `NEW PAID ORDER — $${((o.total_cents + o.shipping_cents) / 100).toFixed(2)} (cards $${(o.total_cents / 100).toFixed(2)} + shipping $${(o.shipping_cents / 100).toFixed(2)})`,
    o.ship_flag ? `⚠️ SHIPPING MISMATCH: ${o.ship_flag}` : null,
    ``,
    o.product === "wedding" ? `WEDDING CARDS${o.guest_names ? " — one per guest" : ""}` : null,
    `${o.qty} cards · ${o.thickness} mm · ${FINISH_LABEL[o.finish] || o.finish}`,
    o.promo_code ? `Promo: ${o.promo_code} (saved $${(o.discount_cents / 100).toFixed(2)})` : null,
    `Front: ${o.design_type === "ai" ? "AI design" : `customer upload (${o.upload_name})`}`,
    o.guest_names ? `Guest names: ${o.guest_names.length}, in ${FONT_LABEL[o.name_font] || o.name_font}. The FRONT file is the template with the name area blank; guest-names.txt is attached. Download every finished card (ZIP) from the orders page.` : null,
    `Back: ${BACK_LABEL[o.back_mode] || "blank"}${o.qr_url ? ` — QR goes to ${o.qr_url}` : ""}`,
    `Files attached are 3.375 x 2.125 in (credit-card size) at 512 DPI. The dark parts of each file are what gets engraved.`,
    `Watch live: ${o.watch_live ? `YES${o.tiktok ? ` — ${o.tiktok}` : ""}` : "no"}`,
    o.notes ? `Notes: ${o.notes}` : null,
    ``,
    `Card text: ${cardText(o)}`,
    ``,
    `Customer: ${o.customer_name || ""} · ${o.customer_email || ""} · ${o.customer_phone || ""}`,
    `Ship to:\n${shipTo}`,
    ``,
    `Orders: ${SITE_URL}/admin`,
  ].filter((l) => l !== null);
  const text = lines.join("\n");
  await sendAlert({
    subject: `New ${o.product === "wedding" ? "wedding card" : "card"} order: ${o.qty} × ${FINISH_LABEL[o.finish] || o.finish} — ${o.customer_name || d.name || d.couple || "customer"}`,
    text,
    html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    attachments: [
      designFile(o, "front"),
      designFile(o, "back"),
      o.guest_names && { filename: `EDZ-${o.id.slice(0, 8)}-guest-names.txt`, contentType: "text/plain", content: o.guest_names.join("\n") },
    ].filter(Boolean),
  });
}

// The thank-you page confirms the payment too, in case the webhook is slow or not set up.
app.get("/api/order-status", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Checkout is off." });
  const sid = String(req.query.session_id || "");
  if (!/^cs_(test|live)_\w+$/.test(sid)) return res.status(400).json({ error: "Bad session." });
  try {
    await markPaid(sid);
    const { rows } = await pool.query("SELECT status, qty, watch_live FROM orders WHERE stripe_session=$1", [sid]);
    res.json(rows[0] || { status: "unknown" });
  } catch (err) {
    console.error("order-status error:", err);
    res.status(500).json({ error: "Couldn't check the order." });
  }
});

// ---------- website plans ----------

// Free cards are shown with their retail value: the cheapest card's price × the count,
// so it stays right if card prices change.
app.get("/api/plans", (req, res) => {
  const cheapestCard = Math.min(...catalog.cardThickness.map((t) => t.perCard)) + Math.min(...catalog.cardFinish.map((f) => f.upcharge));
  res.json({
    plans: plans.PLANS.map((p) => ({ ...p, cardsValueCents: Math.round(p.cards * cheapestCard * 100) })),
    compare: plans.COMPARE,
    businessTypes: businessTypes.TYPES,
  });
});

app.post("/api/plan-checkout", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Online checkout isn't switched on yet." });
  const plan = plans.planById(req.body.plan);
  if (!plan) return res.status(400).json({ error: "Pick a plan." });
  const b = req.body || {};
  const data = {
    business: clean(b.business, 120),
    industry: clean(b.industry, 120),
    description: clean(b.description, 3000),
    services: clean(b.services, 2000),
    area: clean(b.area, 500),
    phone: clean(b.phone, 40),
    email: clean(b.email, 120),
    address: clean(b.address, 300),
    hours: clean(b.hours, 500),
    domain: clean(b.domain, 120),
    domainStatus: ["have", "need"].includes(b.domainStatus) ? b.domainStatus : "have",
    colors: clean(b.colors, 300),
    font: ["modern", "classic", "bold", "friendly"].includes(b.font) ? b.font : null,
    likes: clean(b.likes, 1000),
    notes: clean(b.notes, 3000),
    contactName: clean(b.contactName, 120),
    contactEmail: clean(b.contactEmail, 120),
    contactPhone: clean(b.contactPhone, 40),
    previewSlug: /^[a-z0-9-]{3,90}$/.test(b.previewSlug || "") ? b.previewSlug : null,
    // Kind of business and its answers, the menu (food & drink), their photos with what each
    // shows, and their Google listing (only the place ID is kept from Google).
    type: businessTypes.typeById(b.type)?.id || null,
    extras: businessTypes.cleanExtras(b.type, b.extras),
    menu: businessTypes.typeById(b.type)?.menu ? String(b.menu || "").slice(0, 8000) : "",
    menuImageIds: (Array.isArray(b.menuImageIds) ? b.menuImageIds : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 6),
    photos: (Array.isArray(b.photos) ? b.photos : [])
      .map((x) => ({ id: /\/simg\/([0-9a-f-]{36})\.jpg$/i.exec(String(x?.url || ""))?.[1], label: clean(x?.label, 80) }))
      .filter((x) => x.id),
    googleUrl: /^https:\/\/[^\s"'<>]{6,400}$/i.test(String(b.googleUrl || "").trim()) ? String(b.googleUrl).trim() : "",
    placeId: /^[\w-]{10,300}$/.test(b.placeId || "") ? b.placeId : "",
  };
  if (!data.business) return res.status(400).json({ error: "Add your business name." });
  if (data.photos.length > plan.photos) {
    const more = plans.PLANS.find((x) => x.photos >= data.photos.length);
    return res.status(400).json({ error: `The ${plan.name} plan includes up to ${plan.photos} photos and you added ${data.photos.length}. Remove ${data.photos.length - plan.photos}${more ? `, or switch to ${more.name} for up to ${more.photos}` : ""}.` });
  }
  if (!data.contactName || !/^\S+@\S+\.\S+$/.test(data.contactEmail)) return res.status(400).json({ error: "Add your name and a valid email so we can reach you." });

  let logo = null;
  if (b.logo?.dataUrl) {
    const m = /^data:(image\/(png|jpeg|svg\+xml)|application\/pdf);base64,(.*)$/s.exec(b.logo.dataUrl);
    if (!m) return res.status(400).json({ error: "Logo must be a PNG, JPG, SVG or PDF." });
    logo = { mime: m[1], name: clean(b.logo.name, 120), data: Buffer.from(m[3], "base64") };
  }

  // Businesses Ty messaged on Facebook were offered "no $99 setup fee": $99 off setup
  // (all of it on Launch). Checked against the prospect, so a link can't be edited for it.
  const waiverCents = await setupWaiverFor(data.previewSlug);
  const setupCents = Math.max(0, plan.setupCents - waiverCents);
  // First month free: the monthly plan starts 30 days later than usual.
  const freeDays = waiverCents ? FREE_MONTH_DAYS : 0;
  data.freeMonth = Boolean(freeDays);
  data.setupWaivedCents = plan.setupCents - setupCents;

  const id = crypto.randomUUID();
  try {
    // Setup fee is charged now; the monthly plan starts after the trial (about the delivery time).
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: plan.monthlyCents,
            recurring: { interval: "month" },
            product_data: { name: `${plan.name} website plan — monthly` },
          },
        },
        ...(setupCents > 0
          ? [{
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: setupCents,
                product_data: { name: `${plan.name} website setup (one time)${data.setupWaivedCents ? ` — $${data.setupWaivedCents / 100} off` : ""}` },
              },
            }]
          : []),
      ],
      subscription_data: {
        trial_period_days: plan.trialDays + freeDays,
        description: `${plan.name} website plan for ${data.business}`,
        metadata: { project_id: id, plan: plan.id },
      },
      customer_email: data.contactEmail,
      // Their free metal business cards are shipped here.
      shipping_address_collection: { allowed_countries: ["US"] },
      metadata: { kind: "website", project_id: id, plan: plan.id },
      custom_text: {
        shipping_address: { message: `Where should we ship your ${plan.cards} free metal business cards?` },
        submit: { message: setupCents > 0
          ? `You pay the ${(setupCents / 100).toFixed(0)} dollar setup today. The monthly plan starts in ${plan.trialDays} days, around when your site goes live. Cancel anytime.`
          : `Your setup fee is waived, so nothing is charged today.${freeDays ? ` Your first month is free too, so the monthly plan starts in ${plan.trialDays + freeDays} days.` : ` The monthly plan starts in ${plan.trialDays} days, around when your site goes live.`} Cancel anytime.` },
      },
      success_url: `${SITE_URL}/project-started?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/start?plan=${plan.id}`,
    });
    await pool.query(
      `INSERT INTO projects (id, plan, stripe_session, data, logo_name, logo_mime, logo_data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, plan.id, session.id, data, logo?.name || null, logo?.mime || null, logo?.data || null]
    );
    const imageIds = [...data.photos.map((x) => x.id), ...data.menuImageIds];
    if (imageIds.length) await pool.query("UPDATE project_images SET project_id=$1 WHERE id = ANY($2::uuid[]) AND project_id IS NULL", [id, imageIds]);
    res.json({ url: session.url });
  } catch (err) {
    console.error("plan checkout error:", err);
    res.status(500).json({ error: "Checkout couldn't start. Please try again." });
  }
});

// $99 off website setup for businesses Ty messaged on Facebook (the offer in that message).
// Outreach offer (every message we send): $99 off setup and the first month free, for any
// business we contacted that signs up through its sample-site link.
const SETUP_WAIVER_CENTS = 9900;
const FREE_MONTH_DAYS = 30;
async function setupWaiverFor(slug) {
  if (!/^[a-z0-9-]{3,90}$/.test(slug || "")) return 0;
  const { rows } = await pool.query("SELECT fb_messaged_at FROM prospects WHERE slug=$1", [slug]).catch(() => ({ rows: [] }));
  return rows[0] ? SETUP_WAIVER_CENTS : 0;
}

// Marks a website project paid exactly once, then emails the project details.
async function markProjectPaid(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!["paid", "no_payment_required"].includes(session.payment_status)) return null;
  const cust = session.customer_details || {};
  // Where their free metal business cards go (collected by Stripe Checkout).
  const ship = session.collected_information?.shipping_details || session.shipping_details || null;
  const shipTo = ship?.address ? { name: ship.name || cust.name || "", ...ship.address } : null;
  const { rows } = await pool.query(
    `UPDATE projects SET status='new', paid_at=now(), stripe_subscription=$2, stripe_customer=$3, customer_email=$4, customer_name=$5,
       data = CASE WHEN $6::jsonb IS NULL THEN data ELSE data || jsonb_build_object('shipTo', $6::jsonb) END
     WHERE stripe_session=$1 AND status='pending_payment' RETURNING *`,
    [sessionId, session.subscription || null, session.customer || null, cust.email || null, cust.name || null, shipTo ? JSON.stringify(shipTo) : null]
  );
  if (rows[0]?.data?.previewSlug) {
    await pool.query("UPDATE prospects SET status='won' WHERE slug=$1", [rows[0].data.previewSlug]).catch((e) => console.error("prospect won update failed:", e));
  }
  if (rows[0]) await sendProjectAlert(rows[0]).catch((e) => console.error("project alert failed:", e));
  return rows[0] || null;
}

async function sendProjectAlert(p) {
  const plan = plans.planById(p.plan);
  const d = p.data || {};
  const lines = [
    `NEW WEBSITE PROJECT — ${plan.name} ($${((plan.setupCents - (d.setupWaivedCents || 0)) / 100).toFixed(2)} setup paid${d.setupWaivedCents ? `, $${d.setupWaivedCents / 100} waived (outreach offer)` : ""}, $${(plan.monthlyCents / 100).toFixed(2)}/mo starts in ${plan.trialDays + (d.freeMonth ? 30 : 0)} days${d.freeMonth ? ", first month free" : ""})`,
    `Deliver by: ${plan.delivery.replace(/^Live in /, "")}`,
    plan.cards ? `Includes: ${plan.cards} free metal business cards, shipped to: ${d.shipTo ? [d.shipTo.name, d.shipTo.line1, d.shipTo.line2, `${d.shipTo.city}, ${d.shipTo.state} ${d.shipTo.postal_code}`].filter(Boolean).join(", ") : "(no address given; ask them)"}` : null,
    ``,
    `Business: ${d.business}${d.industry ? ` (${d.industry})` : ""}`,
    d.description ? `About: ${d.description}` : null,
    d.type ? `Kind of business: ${businessTypes.typeById(d.type)?.label || d.type}` : null,
    d.extras?.checks?.length ? `Highlights: ${d.extras.checks.join(", ")}` : null,
    ...(d.extras?.facts || []).map((f) => `${f.label}: ${f.value}`),
    d.extras?.link ? `${d.extras.link.label} button: ${d.extras.link.url}` : null,
    d.services ? `Services: ${d.services}` : null,
    d.menu ? `Menu (read from their photos by AI; they checked it):\n${d.menu}` : null,
    d.menuImageIds?.length ? `Menu photos: ${d.menuImageIds.map((x) => `${SITE_URL}/simg/${x}.jpg`).join(" ")}` : null,
    d.photos?.length ? `Photos (${d.photos.length}):\n${d.photos.map((x, i) => `  ${i + 1}. ${SITE_URL}/simg/${x.id}.jpg${x.label ? ` — ${x.label}` : ""}`).join("\n")}` : null,
    d.googleUrl ? `Google listing (reviews): ${d.googleUrl}` : null,
    d.area ? `Service area: ${d.area}` : null,
    d.domainStatus === "need"
      ? `Domain: NEEDS ONE (free to them) — find the best available name and register it in our Spaceship account${d.domain ? `. Their ideas: ${d.domain}` : ""}`
      : `Domain: ${d.domain || "(not given)"} — they own it; we'll need its DNS pointed at the site`,
    d.colors ? `Colors: ${d.colors}` : null,
    d.font && d.font !== "modern" ? `Font style: ${d.font}` : null,
    d.likes ? `Sites they like: ${d.likes}` : null,
    ``,
    `On the site — phone: ${d.phone || "-"} · email: ${d.email || "-"} · address: ${d.address || "-"}`,
    d.hours ? `Hours: ${d.hours}` : null,
    d.notes ? `Notes: ${d.notes}` : null,
    d.previewSlug ? `Started from our sample homepage: ${SITE_URL}/p/${d.previewSlug}?admin=1 (build from this)` : null,
    ``,
    `Contact: ${d.contactName} · ${d.contactEmail} · ${d.contactPhone || ""}`,
    `Logo: ${p.logo_name ? `${p.logo_name} (attached)` : "none uploaded"}`,
    ``,
    `Projects: ${SITE_URL}/admin`,
  ].filter((l) => l !== null);
  const text = lines.join("\n");
  await sendAlert({
    subject: `New ${plan.name} website: ${d.business}`,
    text,
    html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    attachments: p.logo_data ? [{ filename: p.logo_name || "logo", contentType: p.logo_mime, content: p.logo_data }] : [],
  });
}

app.get("/api/project-status", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Checkout is off." });
  const sid = String(req.query.session_id || "");
  if (!/^cs_(test|live)_\w+$/.test(sid)) return res.status(400).json({ error: "Bad session." });
  try {
    await markProjectPaid(sid);
    const { rows } = await pool.query("SELECT status, plan FROM projects WHERE stripe_session=$1", [sid]);
    const p = rows[0];
    const plan = p && plans.planById(p.plan);
    res.json(p ? { status: p.status, plan: plan.name, delivery: plan.delivery, trialDays: plan.trialDays } : { status: "unknown" });
  } catch (err) {
    console.error("project-status error:", err);
    res.status(500).json({ error: "Couldn't check the project." });
  }
});

// ---------- customer accounts (sign in with an emailed code, reorder past cards) ----------

const SESSION_COOKIE = "edz_session";
const SESSION_DAYS = 60;
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const normEmail = (v) => clean(v, 120).toLowerCase();

function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : null;
}

async function accountEmail(req) {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return null;
  const { rows } = await pool.query("SELECT email FROM sessions WHERE token_hash=$1 AND expires_at > now()", [sha256(token)]);
  return rows[0]?.email || null;
}

async function requireAccount(req, res, next) {
  const email = await accountEmail(req).catch(() => null);
  if (!email) return res.status(401).json({ error: "Please sign in." });
  req.accountEmail = email;
  next();
}

// Always answers the same way, so this can't be used to find out who has ordered.
app.post("/api/account/code", async (req, res) => {
  const email = normEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  if (rateLimited(`code:${req.ip}`, 8) || rateLimited(`code:${email}`, 4)) return res.status(429).json({ error: "Too many codes requested. Try again in an hour." });
  const sent = { ok: true, message: "If you've ordered with that email, we just sent it a 6-digit code. It works for 15 minutes." };
  const { rows } = await pool.query("SELECT 1 FROM orders WHERE lower(customer_email)=$1 AND status <> 'pending_payment' LIMIT 1", [email]);
  if (!rows[0]) return res.json(sent);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await pool.query(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES ($1,$2, now() + interval '15 minutes', 0)
     ON CONFLICT (email) DO UPDATE SET code_hash=EXCLUDED.code_hash, expires_at=EXCLUDED.expires_at, attempts=0`,
    [email, sha256(`${email}:${code}`)]
  );
  await sendToCustomer({
    to: email,
    subject: `Your EDZ Solutions sign-in code: ${code}`,
    text: `Your sign-in code is ${code}\n\nEnter it on ${SITE_URL}/account to see your orders and reorder your cards. It works for 15 minutes.\n\nDidn't ask for this? You can ignore this email.\n\nEDZ Solutions`,
    html: `<div style="font:16px/1.6 Arial,sans-serif;color:#222;max-width:480px"><p>Your EDZ Solutions sign-in code is:</p><p style="font-size:32px;font-weight:800;letter-spacing:6px;color:#0f172a;margin:8px 0 16px">${code}</p><p>Enter it on <a href="${SITE_URL}/account">${SITE_URL.replace(/^https?:\/\//, "")}/account</a> to see your orders and reorder your cards. It works for 15 minutes.</p><p style="color:#888;font-size:13px">Didn't ask for this? You can ignore this email.</p></div>`,
  }).catch((e) => console.error("sign-in code email failed:", e));
  res.json(sent);
});

app.post("/api/account/verify", async (req, res) => {
  const email = normEmail(req.body.email);
  const code = String(req.body.code || "").replace(/\D/g, "");
  const { rows } = await pool.query(
    "UPDATE login_codes SET attempts = attempts + 1 WHERE email=$1 AND expires_at > now() RETURNING code_hash, attempts",
    [email]
  );
  const row = rows[0];
  const ok = row && row.attempts <= 5 && code.length === 6 && crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(sha256(`${email}:${code}`)));
  if (!ok) return res.status(400).json({ error: row && row.attempts > 5 ? "Too many tries. Request a new code." : "That code isn't right, or it expired." });
  await pool.query("DELETE FROM login_codes WHERE email=$1", [email]);
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO sessions (token_hash, email, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [sha256(token), email]);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: SITE_URL.startsWith("https"), sameSite: "lax", maxAge: SESSION_DAYS * 864e5, path: "/" });
  res.json({ ok: true });
});

app.post("/api/account/logout", async (req, res) => {
  const token = cookie(req, SESSION_COOKIE);
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

const ORDER_STATUS_LABEL = { paid: "In the queue to engrave", engraved: "Engraved, getting ready to ship", shipped: "Shipped" };

app.get("/api/account", requireAccount, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, paid_at, status, product, thickness, finish, qty, total_cents, details, back_mode, guest_names, upload_mime, ship_dest
     FROM orders WHERE lower(customer_email)=$1 AND status <> 'pending_payment' ORDER BY paid_at DESC LIMIT 200`,
    [req.accountEmail]
  );
  res.json({
    email: req.accountEmail,
    orders: rows.map((o) => ({
      id: o.id,
      paidAt: o.paid_at,
      status: ORDER_STATUS_LABEL[o.status] || "Received",
      product: o.product,
      thickness: o.thickness,
      finish: o.finish,
      finishLabel: FINISH_LABEL[o.finish] || o.finish,
      qty: o.qty,
      totalCents: o.total_cents,
      title: o.details.company || o.details.name || o.details.couple || "Your cards",
      hasBack: o.back_mode !== "none",
      guestCount: Array.isArray(o.guest_names) ? o.guest_names.length : 0,
      hasImage: /^image\/(png|jpeg)$/.test(o.upload_mime || ""),
      dest: o.ship_dest || "US",
    })),
    thicknesses: catalog.cardThickness.map((t) => ({ id: t.id, label: t.label })),
    finishes: catalog.cardFinish.map((f) => ({ id: f.id, label: f.label })),
    minQty: catalog.MIN_QTY,
    maxQty: catalog.MAX_QTY,
  });
});

// The front design of one of their own orders (only PNG/JPG; uploaded SVG/PDF files aren't shown).
app.get("/api/account/orders/:id/front", requireAccount, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT upload_mime, upload_data FROM orders WHERE id=$1 AND lower(customer_email)=$2 AND status <> 'pending_payment'",
    [req.params.id, req.accountEmail]
  ).catch(() => ({ rows: [] }));
  const o = rows[0];
  if (!o || !/^image\/(png|jpeg)$/.test(o.upload_mime || "")) return res.status(404).end();
  res.set({ "Content-Type": o.upload_mime, "Cache-Control": "private, max-age=86400" }).send(o.upload_data);
});

// Same card again: the saved design files are copied onto a new order at today's prices.
// Quantity, thickness and finish can change; guest place cards keep their guest list.
app.post("/api/account/reorder", requireAccount, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Online checkout isn't switched on yet." });
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE id=$1 AND lower(customer_email)=$2 AND status <> 'pending_payment'",
    [req.body.orderId, req.accountEmail]
  ).catch(() => ({ rows: [] }));
  const old = rows[0];
  if (!old) return res.status(404).json({ error: "We couldn't find that order." });
  const guests = Array.isArray(old.guest_names) ? old.guest_names : null;
  const wedding = old.product === "wedding";
  const quote = catalog.quoteCard({
    thickness: req.body.thickness || old.thickness,
    finish: req.body.finish || old.finish,
    qty: guests ? guests.length : req.body.qty || old.qty,
    back: old.back_mode !== "none",
  });
  if (!quote) return res.status(400).json({ error: `Pick a thickness, finish and a quantity from ${catalog.MIN_QTY} to ${catalog.MAX_QTY}.` });
  const { promo, error: promoError } = await promoFor(req.body.promo, quote, wedding ? "wedding" : "business");
  if (promoError) return res.status(400).json({ error: promoError });
  const price = applyPromo(quote, promo);
  const dest = old.ship_dest || "US";
  const ship = quoteShip(dest, quote, price, promo);
  if (!ship) return res.status(400).json({ error: "Sorry, we can't ship there anymore." });
  try {
    const url = await startCardCheckout({
      id: crypto.randomUUID(), quote, price, promo, ship, dest, wedding, guests, font: old.name_font,
      details: old.details, watchLive: false, tiktok: old.tiktok || "",
      notes: `Reorder of order ${old.id.slice(0, 8)} (same design)`,
      designType: old.design_type, upload: { name: old.upload_name, mime: old.upload_mime, data: old.upload_data },
      backMode: old.back_mode, back: old.back_data ? { name: old.back_name, mime: old.back_mime, data: old.back_data } : null,
      qrUrl: old.qr_url, customerEmail: req.accountEmail, cancelUrl: `${SITE_URL}/account`,
    });
    res.json({ url });
  } catch (err) {
    console.error("reorder error:", err);
    res.status(500).json({ error: "Checkout couldn't start. Please try again." });
  }
});

// ---------- website project inquiries ----------

app.post("/api/inquiry", async (req, res) => {
  const b = req.body || {};
  const record = {
    name: clean(b.name, 80),
    business: clean(b.business, 120),
    email: clean(b.email, 120),
    phone: clean(b.phone, 30),
    type: clean(b.type, 60),
    budget: clean(b.budget, 40),
    message: clean(b.message, 3000),
  };
  if (!record.name || (!record.email && !record.phone)) {
    return res.status(400).json({ error: "Add your name and an email or phone number." });
  }
  try {
    await pool.query("INSERT INTO inquiries (data) VALUES ($1)", [record]);
    const text = Object.entries(record).map(([k, v]) => `${k}: ${v}`).join("\n");
    sendAlert({
      subject: `New website inquiry: ${record.name}${record.business ? ` (${record.business})` : ""}`,
      text,
      html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    }).catch((e) => console.error("inquiry email failed:", e));
    res.json({ ok: true });
  } catch (err) {
    console.error("inquiry error:", err);
    res.status(500).json({ error: "Couldn't send. Please try again." });
  }
});

// ---------- orders admin (password protected) ----------

function requireAdmin(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return res.status(503).send("Set ADMIN_PASSWORD to use the orders page.");
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  // Trim so a pasted password with a stray space or line break still works.
  const given = scheme === "Basic" ? Buffer.from(encoded || "", "base64").toString().split(":").slice(1).join(":").trim() : "";
  const ok = given.length === pass.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pass));
  if (ok) return next();
  res.set("WWW-Authenticate", 'Basic realm="EDZ orders"').status(401).send("Password required.");
}

// Always a fresh copy, so new admin buttons show up without a hard refresh.
app.get("/admin", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "views", "admin.html"), { cacheControl: false, etag: false, lastModified: false });
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, created_at, paid_at, status, details, thickness, finish, qty, total_cents, watch_live, tiktok, notes,
            design_type, product, guest_names, name_font, promo_code, discount_cents, back_mode, qr_url, shipping_cents, ship_dest, ship_flag, (back_data IS NOT NULL) AS has_back, back_name, back_mime, upload_name, upload_mime, customer_email, customer_name, customer_phone, shipping
     FROM orders WHERE status <> 'pending_payment' ORDER BY paid_at DESC LIMIT 2000`
  );
  const { rows: inquiries } = await pool.query("SELECT created_at, data FROM inquiries ORDER BY created_at DESC LIMIT 2000");
  res.json({ orders: rows, inquiries, finishes: FINISH_LABEL });
});

app.get("/api/admin/orders/:id/design", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).send("Not found");
  const f = designFile(rows[0], req.query.side === "back" ? "back" : "front");
  if (!f) return res.status(404).send("No back on this order");
  if (req.query.inline) return res.set("Content-Type", f.contentType).send(f.content);
  res.set("Content-Type", f.contentType).attachment(f.filename).send(f.content);
});

// Wedding guest lists: one finished card, every card as a ZIP, or the names as text.
async function guestOrder(id) {
  const { rows } = await pool.query("SELECT id, upload_data, guest_names, name_font FROM orders WHERE id=$1", [id]).catch(() => ({ rows: [] }));
  return rows[0]?.guest_names ? rows[0] : null;
}

app.get("/api/admin/orders/:id/guest/:n", requireAdmin, async (req, res) => {
  const o = await guestOrder(req.params.id);
  const i = Number(req.params.n);
  const name = o?.guest_names[i];
  if (!name) return res.status(404).send("Not found");
  res.set("Content-Type", "image/jpeg");
  if (!req.query.inline) res.attachment(guestFileName(o, i, name));
  res.send(await guestCard(o, name));
});

app.get("/api/admin/orders/:id/guest-cards.zip", requireAdmin, async (req, res) => {
  const o = await guestOrder(req.params.id);
  if (!o) return res.status(404).send("Not found");
  res.set("Content-Type", "application/zip").attachment(`EDZ-${o.id.slice(0, 8)}-guest-cards.zip`);
  const z = new ZipWriter();
  for (const [i, name] of o.guest_names.entries()) res.write(z.add(guestFileName(o, i, name), await guestCard(o, name)));
  res.end(z.finish());
});

app.get("/api/admin/orders/:id/guest-names.txt", requireAdmin, async (req, res) => {
  const o = await guestOrder(req.params.id);
  if (!o) return res.status(404).send("Not found");
  res.type("text/plain").attachment(`EDZ-${o.id.slice(0, 8)}-guest-names.txt`).send(o.guest_names.join("\n"));
});

app.post("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const status = String(req.body.status || "");
  if (!["paid", "engraved", "shipped"].includes(status)) return res.status(400).json({ error: "Bad status" });
  await pool.query("UPDATE orders SET status=$2 WHERE id=$1 AND status <> 'pending_payment'", [req.params.id, status]);
  res.json({ ok: true });
});

app.get("/api/admin/promos", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM promos ORDER BY created_at DESC");
  res.json({ promos: rows.map((p) => ({ ...p, label: promoLabel(p) })) });
});

app.post("/api/admin/promos", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const code = clean(b.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const kind = String(b.kind || "");
  // Dollar amounts arrive as dollars from the form; store cents.
  const value = kind === "percent" ? Math.round(Number(b.value)) : Math.round(Number(b.value) * 100);
  const maxUses = b.maxUses === "" || b.maxUses == null ? null : Math.round(Number(b.maxUses));
  if (code.length < 3) return res.status(400).json({ error: "Codes need at least 3 letters or numbers." });
  if (!["percent", "amount", "fixed_total"].includes(kind)) return res.status(400).json({ error: "Pick a discount type." });
  if (!Number.isFinite(value) || value < 0 || (kind === "percent" && value > 100)) return res.status(400).json({ error: "Check the discount amount." });
  if (kind === "fixed_total" && value < STRIPE_MIN_CENTS) return res.status(400).json({ error: "The lowest total Stripe can charge is $0.50." });
  if (maxUses != null && !(maxUses > 0)) return res.status(400).json({ error: "Max uses must be blank or a positive number." });
  // Optional limits: blank means any.
  const product = ["business", "wedding"].includes(b.product) ? b.product : null;
  const thickness = catalog.cardThickness.some((t) => t.id === b.thickness) ? b.thickness : null;
  const finish = catalog.cardFinish.some((f) => f.id === b.finish) ? b.finish : null;
  const qty = b.qty === "" || b.qty == null ? null : Math.round(Number(b.qty));
  if (qty != null && !(qty >= catalog.MIN_QTY && qty <= catalog.MAX_QTY)) return res.status(400).json({ error: `Quantity must be blank or ${catalog.MIN_QTY}–${catalog.MAX_QTY}.` });
  try {
    await pool.query("INSERT INTO promos (code, kind, value, max_uses, note, product, thickness, finish, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [code, kind, value, maxUses, clean(b.note, 120) || null, product, thickness, finish, qty]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "That code already exists." });
    throw err;
  }
});

app.post("/api/admin/promos/:code/active", requireAdmin, async (req, res) => {
  await pool.query("UPDATE promos SET active=$2 WHERE code=$1", [req.params.code, Boolean(req.body.active)]);
  res.json({ ok: true });
});

// Past orders keep the code name they used, so deleting a code doesn't change them.
app.delete("/api/admin/promos/:code", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM promos WHERE code=$1", [req.params.code]);
  res.json({ ok: true });
});

app.get("/api/admin/projects", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, created_at, paid_at, status, plan, stripe_subscription, data, logo_name, customer_email, customer_name
     FROM projects WHERE status <> 'pending_payment' ORDER BY paid_at DESC LIMIT 2000`
  );
  res.json({ projects: rows.map((p) => ({ ...p, planName: plans.planById(p.plan)?.name || p.plan })) });
});

app.get("/api/admin/projects/:id/logo", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT logo_name, logo_mime, logo_data FROM projects WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]?.logo_data) return res.status(404).send("No logo");
  res.set("Content-Type", rows[0].logo_mime).attachment(rows[0].logo_name || "logo").send(rows[0].logo_data);
});

app.post("/api/admin/projects/:id/status", requireAdmin, async (req, res) => {
  const status = String(req.body.status || "");
  if (!["new", "in_progress", "launched", "canceled"].includes(status)) return res.status(400).json({ error: "Bad status" });
  await pool.query("UPDATE projects SET status=$2 WHERE id=$1 AND status <> 'pending_payment'", [req.params.id, status]);
  res.json({ ok: true });
});

// ---------- outreach: sample homepages Grok Bot's prospects get emailed ----------

// Email prospects: new → ready → sent → replied / won. Call-list prospects (no email):
// new → call → interested (said yes; link texted) / no_answer / not_interested / won.
const PROSPECT_STATUSES = ["new", "ready", "sending", "sent", "replied", "won", "unsubscribed", "bounced", "skipped", "call", "no_answer", "messaged", "interested", "not_interested"];

function slugify(v) {
  return String(v || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function siteDomain(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

// "fb:<page>" for a Facebook page link, matching scripts/find-facebook-leads.js: the page name,
// or people/<name>/<id>, p/<name-id>, pages/<name>/<id>, profile.php?id=<id>.
function facebookKey(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length) return null;
  const page = parts[0] === "profile.php" ? `profile.php?id=${u.searchParams.get("id") || ""}`
    : parts[0] === "people" ? parts.slice(0, 3).join("/")
    : parts[0] === "pages" ? parts.slice(0, 3).join("/")
    : parts[0] === "p" ? parts.slice(0, 2).join("/")
    : parts[0];
  // Pages with a numeric id are keyed by it, so p/Name-123… and people/Name/123… match.
  const id = /(?:^|[-/=])(\d{9,})$/.exec(page);
  return id ? `fb:id:${id[1]}` : `fb:${page.toLowerCase()}`;
}

// One lead from Grok Bot → the row to insert, or { error }. Only facts from their site are kept.
function prospectFromLead(lead) {
  const l = lead || {};
  const email = clean(l.email, 120).toLowerCase();
  const phoneKey = String(l.phone || "").replace(/\D/g, "").slice(-10);
  const data = {
    business: clean(l.business, 100),
    contactName: clean(l.contactName, 80),
    industry: clean(l.industry, 60),
    city: clean(l.city, 60),
    state: clean(l.state, 30),
    area: clean(l.area, 160),
    phone: clean(l.phone, 30),
    email,
    address: clean(l.address, 200),
    hours: String(l.hours || "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, 300),
    tagline: clean(l.tagline, 110),
    about: String(l.about || "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, 1200),
    services: (Array.isArray(l.services) ? l.services : [])
      .map((x) => (typeof x === "string" ? { name: clean(x, 60) } : { name: clean(x?.name, 60), desc: clean(x?.desc, 220) }))
      .filter((x) => x.name)
      .slice(0, 9),
    website: clean(l.website, 200),
    logoUrl: safeUrl(l.logoUrl),
    // Header banner chosen in Edit info (empty = AI trade photo); heroSeparate means their
    // photos are for About/"Take a look", not the header.
    heroUrl: safeUrl(l.heroUrl),
    heroSeparate: l.heroSeparate === true || l.heroSeparate === "1" || undefined,
    // Photos with what each one shows (labels line up with the links).
    ...(() => {
      const pairs = (Array.isArray(l.photoUrls) ? l.photoUrls : [])
        .map((u, i) => [safeUrl(u), clean((Array.isArray(l.photoLabels) ? l.photoLabels : [])[i], 80)])
        .filter(([u]) => u)
        .slice(0, 6);
      return { photoUrls: pairs.map(([u]) => u), photoLabels: pairs.map(([, t]) => t) };
    })(),
    // Kind of business and its answers (badges, an order/booking button, short facts) and, for
    // food & drink, the menu ("Section" lines, then "- Item | price | description").
    ...(() => {
      const type = businessTypes.typeById(l.type);
      if (!type) return { type: "" };
      const x = businessTypes.cleanExtras(type.id, l.extras);
      const menuText = Array.isArray(l.menu) ? startExtras.menuToText(l.menu) : String(l.menu || "");
      return { type: type.id, extras: businessTypes.cleanAnswers(type.id, l.extras), badges: x.checks, ctaLink: x.link, typeFacts: x.facts, menu: type.menu ? startExtras.parseMenu(menuText) : [] };
    })(),
    color: hexColor(l.color, ""),
    hook: clean(l.hook, 200),
    whyOutdated: clean(l.whyOutdated, 300),
    source: clean(l.source, 200),
    // No-website businesses: where their info (and email, if any) came from.
    noWebsite: !l.website,
    emailSource: clean(l.emailSource, 120), // e.g. "your Facebook page"
    facebookUrl: /^https:\/\/(www\.|m\.)?facebook\.com\//.test(l.facebookUrl || "") ? clean(l.facebookUrl, 200) : "",
    yelpUrl: /^https:\/\/(www\.|m\.)?yelp\.com\//.test(l.yelpUrl || "") ? clean(l.yelpUrl, 200) : "",
    googleMapsUrl: /^https:\/\/(maps\.google\.com|www\.google\.com\/maps|maps\.app\.goo\.gl)/.test(l.googleMapsUrl || "") ? clean(l.googleMapsUrl, 300) : "",
    // Google place ID (the only Google data we may keep): the sample page loads their Google photos,
    // rating and reviews live with it. Unset = not looked up yet; "" = no Google listing found.
    ...(l.placeId !== undefined ? { placeId: /^[\w-]{10,300}$/.test(l.placeId || "") ? l.placeId : "" } : {}),
  };
  if (!data.business) return { error: "no business name" };
  const hasEmail = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);
  if (email && !hasEmail) return { error: "email doesn't look valid" };
  const domain = data.website ? siteDomain(data.website) : null;
  if (data.website && !domain) return { error: "website address doesn't look valid" };
  // A Facebook page alone is enough for the call list (you message them there by hand).
  const fbKey = data.facebookUrl ? facebookKey(data.facebookUrl) : null;
  if (!hasEmail && phoneKey.length !== 10 && !fbKey) return { error: "no email, no 10-digit phone and no Facebook page" };
  // A weak site (blank Square page, outdated site) with no email still goes on the call list
  // when there's a phone; its call script and messages say "new homepage", not "no website".
  if (!hasEmail && domain && phoneKey.length !== 10) return { error: "has a website but no email or phone" };
  const slug = `${slugify(`${data.business} ${data.city}`)}-${crypto.randomBytes(2).toString("hex")}`;
  // phone_key dedupes businesses without a website: by phone, or by Facebook page when there's no phone.
  const dedupeKey = phoneKey.length === 10 ? phoneKey : domain ? null : fbKey;
  return { slug, email: hasEmail ? email : null, domain, data, channel: hasEmail ? "email" : "call", phoneKey: dedupeKey };
}

app.post("/api/admin/prospects", requireAdmin, async (req, res) => {
  const leads = Array.isArray(req.body) ? req.body : req.body?.prospects;
  if (!Array.isArray(leads) || !leads.length) return res.status(400).json({ error: "Send an array of prospects." });
  const added = [];
  const skipped = [];
  for (const lead of leads.slice(0, 200)) {
    const p = prospectFromLead(lead);
    if (p.error) {
      skipped.push({ business: lead?.business || "?", reason: p.error });
      continue;
    }
    // Deleted earlier (do-not-contact list)? Then never again.
    const keys = [p.email, p.domain && `d:${p.domain}`, p.phoneKey && `k:${p.phoneKey}`].filter(Boolean);
    if ((await pool.query("SELECT 1 FROM suppressions WHERE key = ANY($1) LIMIT 1", [keys])).rows[0]) {
      skipped.push({ business: p.data.business, reason: "removed earlier (do-not-contact list)" });
      continue;
    }
    // The unique indexes on email and website domain mean nobody is ever added (or emailed) twice.
    const { rows } = await pool.query(
      // Call-list businesses show up right away; email ones wait for their screenshot (status new).
      `INSERT INTO prospects (id, slug, email, domain, data, unsub_token, channel, phone_key, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING RETURNING id, slug`,
      [crypto.randomUUID(), p.slug, p.email, p.domain, p.data, crypto.randomBytes(16).toString("hex"), p.channel, p.phoneKey, p.channel === "call" ? "call" : "new"]
    );
    if (rows[0]) await claimImages(rows[0].id, p.data);
    if (rows[0]) added.push({ id: rows[0].id, slug: rows[0].slug, business: p.data.business, channel: p.channel });
    else skipped.push({ business: p.data.business, reason: "already in the list (same email, website or phone)" });
  }
  res.json({ added, skipped });
});

// Every website domain already in the prospect list, so the lead finder skips them.
app.get("/api/admin/prospect-domains", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT domain, phone_key FROM prospects WHERE domain IS NOT NULL OR phone_key IS NOT NULL");
  const { rows: gone } = await pool.query("SELECT key FROM suppressions WHERE key LIKE 'd:%' OR key LIKE 'k:%'");
  res.json({
    domains: [...rows.map((r) => r.domain), ...gone.filter((g) => g.key.startsWith("d:")).map((g) => g.key.slice(2))].filter(Boolean),
    phones: [...rows.map((r) => r.phone_key), ...gone.filter((g) => g.key.startsWith("k:")).map((g) => g.key.slice(2))].filter(Boolean),
  });
});

app.get("/api/admin/prospects", requireAdmin, async (req, res) => {
  const status = PROSPECT_STATUSES.includes(req.query.status) ? req.query.status : null;
  // Paged: ?limit=10..500&offset=n (the admin shows 10–500 at a time).
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 500));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  // No status = everything still in play (finished ones have their own filters).
  // ?view=outreach (the Outreach tab) is email businesses only, plus Skipped and Won from the call
  // list (removed cards are undone or deleted there); call-list work happens on the Call list tab.
  const only = req.query.view === "outreach" ? "(channel='email' OR status IN ('skipped', 'won'))" : "TRUE";
  const where = `${status ? "WHERE status=$1" : "WHERE status NOT IN ('skipped', 'bounced', 'unsubscribed')"} AND ${only}`;
  const { rows } = await pool.query(
    `SELECT id, created_at, slug, email, domain, status, prev_status, followup_at, fb_messaged_at, fb_followup_at, channel, data, sent_at, sent_from, views, last_view_at, notes, shot IS NOT NULL AS has_shot
     FROM prospects ${where} ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ${limit} OFFSET ${offset}`,
    status ? [status] : []
  );
  const total = (await pool.query(`SELECT count(*)::int AS n FROM prospects ${where}`, status ? [status] : [])).rows[0].n;
  const counts = await pool.query(`SELECT status, count(*)::int AS n FROM prospects WHERE ${only} GROUP BY status`);
  const sent24 = await pool.query("SELECT count(*)::int AS n FROM prospects WHERE sent_at > now() - interval '24 hours'");
  res.json({
    prospects: rows,
    total,
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
    sentLast24h: sent24.rows[0].n,
    dailyLimit: outreach.settings().dailyLimit,
    notReady: outreach.notReady(),
    mailboxes: await outreach.mailboxStats(pool),
    queue: (await pool.query("SELECT count(*)::int AS n FROM prospects WHERE status IN ('new','ready') AND channel='email'")).rows[0].n,
    callList: (await pool.query("SELECT count(*)::int AS n FROM prospects WHERE status='call'")).rows[0].n,
    sendingNow: outreach.inWindow(),
    inboxCheckedAt: (await pool.query("SELECT max(checked_at) AS t FROM inbox_state")).rows[0].t,
  });
});

// Screenshot of the sample homepage (taken by scripts/outreach-daily.js with headless Chrome).
app.post("/api/admin/prospects/:id/shot", requireAdmin, express.raw({ type: "image/*", limit: "15mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Send the PNG as the body." });
  try {
    const img = sharp(req.body).resize({ width: 1088 });
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    const jpg = await sharp(data).extract({ left: 0, top: 0, width: info.width, height: Math.min(info.height, 1300) }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    const { rowCount } = await pool.query(
      "UPDATE prospects SET shot=$2, status=CASE WHEN status='new' THEN (CASE WHEN channel='call' THEN 'call' ELSE 'ready' END) ELSE status END WHERE id=$1",
      [req.params.id, jpg]
    );
    if (!rowCount) return res.status(404).json({ error: "No such prospect." });
    res.json({ ok: true, bytes: jpg.length });
  } catch (err) {
    console.error("prospect shot error:", err);
    res.status(400).json({ error: "Couldn't read that image." });
  }
});

app.get("/api/admin/prospects/:id/email", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM prospects WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).send("No such prospect.");
  const email = req.query.followup ? outreach.buildFollowup(rows[0], SITE_URL) : outreach.buildEmail(rows[0], SITE_URL);
  res.type("html").send(req.query.text ? `<pre>${escapeHtml(email.text)}</pre>` : email.html);
});

app.post("/api/admin/prospects/:id/status", requireAdmin, async (req, res) => {
  const status = String(req.body.status || "");
  if (!PROSPECT_STATUSES.includes(status) || status === "sending") return res.status(400).json({ error: "Bad status" });
  // Unsubscribed is final (they asked us to stop), so it can't be changed here.
  await pool.query(
    `UPDATE prospects SET prev_status=status, status=$2, notes=COALESCE($3, notes),
       fb_messaged_at = CASE WHEN $2 = 'messaged' THEN now() ELSE fb_messaged_at END
     WHERE id=$1 AND status <> 'unsubscribed' AND status <> $2`,
    [req.params.id, status, req.body.notes ?? null]
  );
  res.json({ ok: true });
});

// Found their email later (call-list business): it moves to the email queue. It's emailed once
// its screenshot exists (right away if it has one, else after the next daily script run).
app.post("/api/admin/prospects/:id/email", requireAdmin, async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return res.status(400).json({ error: "That email doesn't look right." });
  const source = clean(req.body.source, 120) || "your public business listing";
  try {
    const { rowCount } = await pool.query(
      `UPDATE prospects SET email=$2, channel='email', prev_status=status,
         status=CASE WHEN shot IS NOT NULL THEN 'ready' ELSE 'new' END,
         data = data || jsonb_build_object('email', $2::text, 'emailSource', $3::text)
       WHERE id=$1 AND channel='call' AND status IN ('call', 'no_answer')`,
      [req.params.id, email, source]
    );
    if (!rowCount) return res.status(400).json({ error: "Only businesses still on the call list can get an email added." });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "That email is already in the outreach list." });
    throw err;
  }
});

// Edit info (call-list business): fill in what the lead search missed (address, services, logo...).
// Cleaned the same way as a new lead. The sample page reads it live; the screenshot is cleared so
// the next daily run retakes it for the text/Messenger link preview.
app.post("/api/admin/prospects/:id/info", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT data, domain, channel FROM prospects WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "No such business." });
  if (rows[0].channel !== "call") return res.status(400).json({ error: "Only call-list businesses can be edited here." });
  const old = rows[0].data || {};
  const fields = ["business", "contactName", "industry", "city", "state", "area", "phone", "email", "address", "hours", "tagline", "about", "services", "facebookUrl", "yelpUrl", "googleMapsUrl", "logoUrl", "heroUrl", "heroSeparate", "photoUrls", "photoLabels", "type", "extras", "menu"];
  const input = Object.fromEntries(fields.filter((k) => k in req.body).map((k) => [k, req.body[k]]));
  const p = prospectFromLead({ ...old, ...input });
  if (p.error) return res.status(400).json({ error: `Couldn't save: ${p.error}.` });
  for (const [k, v, label] of [["facebookUrl", input.facebookUrl, "Facebook"], ["yelpUrl", input.yelpUrl, "Yelp"], ["googleMapsUrl", input.googleMapsUrl, "Google listing"], ["logoUrl", input.logoUrl, "logo"], ["heroUrl", input.heroUrl, "header banner"]]) {
    if (v && !p.data[k]) return res.status(400).json({ error: `That ${label} link doesn't look right.` });
  }
  // The email here is shown on their site; "Found their email" is what moves them to the email queue.
  const data = { ...old, ...p.data, noWebsite: old.noWebsite ?? p.data.noWebsite, emailSource: old.emailSource || p.data.emailSource, source: old.source || p.data.source };
  // New name or address: find their Google listing again on the next page view.
  if (["business", "address", "city", "state"].some((k) => (old[k] || "") !== (data[k] || ""))) delete data.placeId;
  try {
    await pool.query(
      "UPDATE prospects SET data=$2, phone_key=COALESCE($3, phone_key), shot=NULL WHERE id=$1",
      [req.params.id, data, rows[0].domain ? null : p.phoneKey]
    );
    await claimImages(req.params.id, data);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Another business on the list already has that phone number or Facebook page." });
    throw err;
  }
  res.json({ ok: true });
});

// Upload a logo or photo for a business's sample site ("+ Add a business" or Edit info). Returns
// its link, which the form puts in the logo/photo field; saving the business links the image to it.
// Logos keep transparency (PNG, up to 800 px); photos are JPEG, up to 1600 px, turned upright.
async function saveUpload(req, res, prospectId) {
  const logo = req.query.kind === "logo";
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No image received." });
  let out;
  try {
    const img = sharp(req.body).rotate().resize({ width: logo ? 800 : 1600, height: logo ? 800 : 1600, fit: "inside", withoutEnlargement: true });
    out = logo ? await img.png().toBuffer() : await img.flatten({ background: "#ffffff" }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch {
    return res.status(400).json({ error: "Couldn't read that image. Try a JPG or PNG." });
  }
  const id = crypto.randomUUID();
  try {
    await pool.query("INSERT INTO prospect_images (id, prospect_id, image, type) VALUES ($1,$2,$3,$4)", [id, prospectId, out, logo ? "png" : "jpg"]);
  } catch {
    return res.status(404).json({ error: "No such business." });
  }
  // Uploads for a business that was never added.
  pool.query("DELETE FROM prospect_images WHERE prospect_id IS NULL AND created_at < now() - interval '2 days'").catch(() => {});
  res.json({ url: `${SITE_URL}/pimg/${id}.${logo ? "png" : "jpg"}` });
}
const imageBody = express.raw({ type: "image/*", limit: "20mb" });
app.post("/api/admin/prospects/:id/upload", requireAdmin, imageBody, (req, res) => saveUpload(req, res, req.params.id));
app.post("/api/admin/uploads", requireAdmin, imageBody, (req, res) => saveUpload(req, res, null));

// Reads menu photos uploaded in the admin forms (their /pimg/ links) into menu text.
app.post("/api/admin/menu-read", requireAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: "Menu reading isn't set up (no OpenAI key)." });
  const ids = (Array.isArray(req.body?.urls) ? req.body.urls : []).map((u) => /\/pimg\/([0-9a-f-]{36})\./i.exec(u || "")?.[1]).filter(Boolean).slice(0, 6);
  if (!ids.length) return res.status(400).json({ error: "Upload a photo of the menu first." });
  const { rows } = await pool.query("SELECT image FROM prospect_images WHERE id = ANY($1::uuid[])", [ids]);
  try {
    const images = await Promise.all(rows.map((r) => sharp(r.image).flatten({ background: "#ffffff" }).jpeg().toBuffer()));
    const sections = await startExtras.readMenu(openai, images);
    if (!sections.length) return res.status(422).json({ error: "Couldn't read a menu in that photo. Try a clearer, straight-on photo." });
    res.json({ text: startExtras.menuToText(sections), items: sections.reduce((n, x) => n + x.items.length, 0) });
  } catch (err) {
    console.error("admin menu read failed:", err.message);
    res.status(502).json({ error: "The menu reader hit a snag. Try again." });
  }
});

// Links images uploaded before the business existed (their /pimg/ ids are in its logo/photo links).
function claimImages(prospectId, data) {
  const ids = [data.logoUrl, data.heroUrl, ...(data.photoUrls || [])].map((u) => /\/pimg\/([0-9a-f-]{36})\./i.exec(u || "")?.[1]).filter(Boolean);
  if (!ids.length) return Promise.resolve();
  return pool.query("UPDATE prospect_images SET prospect_id=$1 WHERE id = ANY($2::uuid[]) AND prospect_id IS NULL", [prospectId, ids]).catch((e) => console.error("claim images failed:", e));
}

app.get("/pimg/:id.:ext", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
  const { rows } = await pool.query("SELECT image, type FROM prospect_images WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).end();
  res.set({ "Content-Type": rows[0].type === "png" ? "image/png" : "image/jpeg", "Cache-Control": "public, max-age=604800" }).send(rows[0].image);
});

// Deletes finished prospects (skipped, bounced, unsubscribed) and keeps only their
// email/website/phone on the do-not-contact list. Body: { ids: [...] } or { status: "skipped" } for all.
app.post("/api/admin/prospects/delete", requireAdmin, async (req, res) => {
  const FINISHED = ["skipped", "bounced", "unsubscribed"];
  const status = FINISHED.includes(req.body.status) ? req.body.status : null;
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 2000) : [];
  if (!status && !ids.length) return res.status(400).json({ error: "Nothing to delete." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `DELETE FROM prospects WHERE status = ANY($1) AND ${status ? "status=$2" : "id = ANY($2::uuid[])"} RETURNING email, domain, phone_key, status`,
      [FINISHED, status || ids]
    );
    for (const r of rows) {
      for (const key of [r.email, r.domain && `d:${r.domain}`, r.phone_key && `k:${r.phone_key}`].filter(Boolean)) {
        await client.query("INSERT INTO suppressions (key, reason) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING", [key, r.status]);
      }
    }
    await client.query("COMMIT");
    res.json({ deleted: rows.length });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Ty sent the Facebook follow-up message (call list "Messaged" tab).
app.post("/api/admin/prospects/:id/fb-followup", requireAdmin, async (req, res) => {
  await pool.query("UPDATE prospects SET fb_followup_at=now() WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Puts a prospect back to the status it had before the last change (clicking its status badge).
app.post("/api/admin/prospects/:id/undo", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE prospects SET status=prev_status, prev_status=NULL WHERE id=$1 AND prev_status IS NOT NULL AND status <> 'unsubscribed'
     RETURNING status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: "Nothing to undo." });
  res.json({ ok: true, status: rows[0].status });
});

// The follow-up email for one business, sent right away from the mailbox that sent the first one.
app.post("/api/admin/prospects/:id/followup", requireAdmin, async (req, res) => {
  const out = await outreach.sendFollowup(pool, SITE_URL, req.params.id);
  res.status(out.error ? 400 : 200).json(out);
});

// Checks the outreach inboxes for bounces and replies right now (the server also does it every 15 minutes).
app.post("/api/admin/outreach/check-inbox", requireAdmin, async (req, res) => {
  res.json({ found: await inbox.checkAll(pool) });
});

// Sends ONE email right now (ignores the weekday window; the timer below respects it).
app.post("/api/admin/outreach/send-next", requireAdmin, async (req, res) => {
  const out = await outreach.sendNext(pool, SITE_URL);
  res.status(out.error ? 502 : 200).json(out);
});

// Public sample homepage. ?shot=1 hides the EDZ banner for the screenshot; ?shot / ?admin views aren't counted.
app.get("/p/:slug", async (req, res) => {
  const { rows } = await pool.query("SELECT id, slug, data, sent_at, shot IS NOT NULL AS has_shot FROM prospects WHERE slug=$1", [req.params.slug]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
  const shot = req.query.shot === "1";
  // Email security scanners (Microsoft, Proofpoint...) open every link within a few minutes of
  // delivery, so visits in the first 5 minutes after sending aren't counted as views.
  const scannerWindow = rows[0].sent_at && Date.now() - new Date(rows[0].sent_at) < 5 * 60 * 1000;
  const robot = /bot|crawl|spider|preview|scan|fetch/i.test(req.headers["user-agent"] || "");
  if (!shot && !req.query.admin && !scannerWindow && !robot) {
    pool.query("UPDATE prospects SET views=views+1, last_view_at=now() WHERE id=$1", [rows[0].id]).catch(() => {});
  }
  // Their Google photos, rating and reviews, loaded live for people (not the stored screenshot,
  // link scanners or bots: Google's content may not be saved, and each load is a paid call).
  let googleInfo = null;
  if (!shot && !robot && !scannerWindow) {
    const d = rows[0].data;
    if (d.placeId === undefined) {
      d.placeId = await googlePlaces.findPlaceId(d).catch(() => undefined);
      if (d.placeId !== undefined) pool.query("UPDATE prospects SET data = data || jsonb_build_object('placeId', $2::text) WHERE id=$1", [rows[0].id, d.placeId]).catch(() => {});
    }
    googleInfo = await googlePlaces.placeContent(pool, d.placeId, d.business);
  }
  // No photos of their own: use the trade's stock photo (made in the background if it's new).
  let heroImage = "";
  const pd = rows[0].data;
  if (pd.heroSeparate ? !pd.heroUrl : !(pd.photoUrls || []).length && !googleInfo?.photos.length) {
    const key = await tradeImages.hasTradeImage(pool, rows[0].data.industry);
    if (key) heroImage = `/trade-img/${key}.jpg`;
    else tradeImages.ensureTradeImage(pool, openai, IMAGE_MODEL, rows[0].data.industry);
  }
  res.set("X-Robots-Tag", "noindex").type("html").send(renderPreview(rows[0], { shot, siteUrl: SITE_URL, hasShot: rows[0].has_shot, heroImage, google: googleInfo, claimUrl: `/start?plan=launch&preview=${rows[0].slug}` }));
});

// The trade's AI stock photo (hero background for sample pages without the business's photos).
app.get("/trade-img/:key.jpg", async (req, res) => {
  const { rows } = await pool.query("SELECT image FROM trade_images WHERE key=$1", [req.params.key]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800" }).send(rows[0].image);
});

// Makes sure a prospect's trade photo exists before its screenshot is taken (the daily script
// calls this first). Waits for the image model when the trade has no photo yet (~10-20 s).
app.post("/api/admin/prospects/:id/prepare", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT data FROM prospects WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  const d = rows[0]?.data;
  if (!d) return res.status(404).json({ error: "No such prospect." });
  const needTrade = d.heroSeparate ? !d.heroUrl : !(d.photoUrls || []).length;
  const key = needTrade ? await tradeImages.ensureTradeImage(pool, openai, IMAGE_MODEL, d.industry) : null;
  res.json({ tradeImage: key });
});

// Wide 1200x630 crop of the top of their homepage: the picture Messenger, iMessage and texts
// show when the sample-page link is pasted.
app.get("/p/:slug/og.jpg", async (req, res) => {
  const { rows } = await pool.query("SELECT shot FROM prospects WHERE slug=$1", [req.params.slug]).catch(() => ({ rows: [] }));
  if (!rows[0]?.shot) return res.redirect(302, "/img/home-websites.jpg");
  const img = await sharp(rows[0].shot).resize({ width: 1200 }).extract({ left: 0, top: 0, width: 1200, height: 630 }).jpeg({ quality: 82 }).toBuffer().catch(() => null);
  if (!img) return res.redirect(302, "/img/home-websites.jpg");
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }).send(img);
});

app.get("/p/:slug/shot.jpg", async (req, res) => {
  const { rows } = await pool.query("SELECT shot FROM prospects WHERE slug=$1", [req.params.slug]).catch(() => ({ rows: [] }));
  if (!rows[0]?.shot) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }).send(rows[0].shot);
});

// ---------- AI logo maker (start form, for businesses without a logo) ----------
// Three logos in different directions, made in parallel; the page polls for them because the
// image model can take longer than Heroku's 30 s request limit. Results live in memory briefly.
const logoJobs = new Map();
const LOGO_DIRECTIONS = [
  "A simple icon that fits the trade, placed to the left of the business name",
  "A round badge or emblem with the business name inside it",
  "A bold wordmark: just the business name in distinctive, well-crafted lettering with one small accent shape",
];
app.post("/api/logo-ai", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "The logo maker isn't switched on yet." });
  const business = clean(req.body.business, 60);
  if (!business) return res.status(400).json({ error: "Add your business name first." });
  if (rateLimited(`logo:${req.ip}`, 6)) return res.status(429).json({ error: "That's a lot of logos for one hour. Try again a little later." });
  const industry = clean(req.body.industry, 60);
  const style = clean(req.body.style, 300);
  for (const [k, j] of logoJobs) if (Date.now() - j.createdAt > 15 * 60 * 1000) logoJobs.delete(k);
  const id = crypto.randomUUID();
  const job = { createdAt: Date.now(), status: "working" };
  logoJobs.set(id, job);
  Promise.all(LOGO_DIRECTIONS.map(async (direction) => {
    const result = await openai.images.generate({
      model: IMAGE_MODEL,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
      background: "transparent",
      prompt: `Design a professional logo for "${business}"${industry ? `, a ${industry.toLowerCase()} business` : ""}. ${direction}.${style ? ` The owner's style request: ${style}.` : ""} Spell the name exactly "${business}". Flat, clean vector look with one to three solid colors, crisp edges, easy to read at small sizes. Centered on a plain transparent background with some empty space around it. No mockup, no photo, no 3D, no drop shadows, and no other words, slogans or taglines.`,
    });
    const b64 = result.data?.[0]?.b64_json;
    return b64 ? `data:image/png;base64,${b64}` : null;
  }))
    .then((images) => Object.assign(job, { status: "done", images: images.filter(Boolean) }))
    .catch((err) => {
      console.error("logo maker error:", err.status, err.code, err.message);
      Object.assign(job, { status: "error", error: err.code === "moderation_blocked" ? "That request can't be made. Try different words." : "The logo maker hit a snag. Please try again." });
    });
  res.status(202).json({ jobId: id });
});
app.get("/api/logo-ai/:id", (req, res) => {
  const job = logoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Those logos expired. Make new ones." });
  if (job.status === "error") return res.status(500).json({ error: job.error });
  res.json({ status: job.status, images: job.status === "done" ? job.images : undefined });
});

// Common color words from the /start form's "Colors you like" → the site's main color.
const COLOR_WORDS = { navy: "#1e3a8a", blue: "#1d4ed8", "sky blue": "#0284c7", teal: "#0f766e", green: "#15803d", "forest green": "#166534", lime: "#65a30d", red: "#b91c1c", maroon: "#7f1d1d", burgundy: "#7f1d1d", orange: "#ea580c", yellow: "#ca8a04", gold: "#b8860b", purple: "#6d28d9", pink: "#db2777", brown: "#78350f", tan: "#a16207", black: "#111827", gray: "#4b5563", grey: "#4b5563", silver: "#64748b" };
function colorFromWords(text) {
  const t = String(text || "").toLowerCase();
  const hex = /#[0-9a-f]{6}\b/.exec(t);
  if (hex) return hex[0];
  const word = Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  return word ? COLOR_WORDS[word] : "";
}

// Live website preview for the /start form: the sample we made for them (when they came from
// one) with whatever they've typed on top, or built from the form alone. Nothing is saved.
// ---------- /start form extras: photos, menu reading, Google reviews ----------
// A photo (or a menu page) for their website, uploaded before checkout. Returns its link for the
// live preview; checkout links it to the project. Public, so rate-limited and resized.
app.post("/api/start-upload", express.raw({ type: "image/*", limit: "20mb" }), async (req, res) => {
  if (rateLimited(`upload:${req.ip}`, 120)) return res.status(429).json({ error: "That's a lot of uploads. Please try again in a bit." });
  const kind = req.query.kind === "menu" ? "menu" : "photo";
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No image received." });
  let image;
  try {
    // Menu pages stay larger so small print is still readable.
    const max = kind === "menu" ? 2400 : 1600;
    image = await sharp(req.body).rotate().resize({ width: max, height: max, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  } catch {
    return res.status(400).json({ error: "Couldn't read that image. Try a JPG or PNG (or a screenshot of it)." });
  }
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO project_images (id, kind, image) VALUES ($1,$2,$3)", [id, kind, image]);
  pool.query("DELETE FROM project_images WHERE project_id IS NULL AND created_at < now() - interval '2 days'").catch(() => {});
  res.json({ id, url: `${SITE_URL}/simg/${id}.jpg` });
});

app.get("/simg/:id.jpg", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
  const { rows } = await pool.query("SELECT image FROM project_images WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800", "X-Robots-Tag": "noindex" }).send(rows[0].image);
});

// Reads their uploaded menu pages with AI into menu text they can check and fix on the form.
app.post("/api/start-menu", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "Menu reading isn't available right now. Type your menu in instead." });
  if (rateLimited(`menu:${req.ip}`, 12)) return res.status(429).json({ error: "Please wait a bit before reading the menu again." });
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 6);
  if (!ids.length) return res.status(400).json({ error: "Upload a photo of your menu first." });
  const { rows } = await pool.query("SELECT image FROM project_images WHERE id = ANY($1::uuid[]) AND kind='menu'", [ids]);
  if (!rows.length) return res.status(400).json({ error: "Upload a photo of your menu first." });
  try {
    const sections = await startExtras.readMenu(openai, rows.map((r) => r.image));
    if (!sections.length) return res.status(422).json({ error: "We couldn't read a menu in that photo. Try a clearer, straight-on photo, or type it in." });
    res.json({ text: startExtras.menuToText(sections), items: sections.reduce((n, x) => n + x.items.length, 0) });
  } catch (err) {
    console.error("menu read failed:", err.message);
    res.status(502).json({ error: "The menu reader hit a snag. Please try again, or type your menu in." });
  }
});

// Their Google Maps link → their rating, reviews and photos for the live preview. The form keeps
// what we send back and returns it with each preview, so Google is called once per link.
app.post("/api/start-google", async (req, res) => {
  if (rateLimited(`google:${req.ip}`, 10)) return res.status(429).json({ error: "Please wait a bit before trying another link." });
  const b = req.body || {};
  const placeId = await startExtras.placeIdFromLink(b.url, { business: clean(b.business, 100), address: clean(b.address, 200), area: clean(b.area, 160) });
  if (!placeId) {
    const missing = !clean(b.business, 100) ? "your business name" : !clean(b.address, 200) && !clean(b.area, 160) ? "your town (Area you serve) or address" : "";
    return res.status(404).json({ error: missing ? `We couldn't find that listing from the link alone. Fill in ${missing} above, then paste the link again.` : "We couldn't find that Google listing. Copy the link from the Share button on your Google Maps listing." });
  }
  const google = await googlePlaces.placeContent(pool, placeId, clean(b.business, 100), { trusted: true });
  if (!google) return res.status(502).json({ error: "Google didn't send your reviews just now. We'll still add them when we build your site." });
  res.json({ placeId, google });
});

app.post("/api/preview-draft", async (req, res) => {
  if (rateLimited(`draft:${req.ip}`, 400)) return res.status(429).json({ error: "Slow down a little." });
  const b = req.body || {};
  let base = {};
  if (/^[a-z0-9-]{3,90}$/.test(b.previewSlug || "")) {
    const { rows } = await pool.query("SELECT data FROM prospects WHERE slug=$1", [b.previewSlug]).catch(() => ({ rows: [] }));
    base = rows[0]?.data || {};
  }
  const pick = (v, max) => (v === undefined || v === null || v === "" ? undefined : clean(v, max));
  const lines = (v) => String(v || "").split(/\r?\n|,\s*/).map((x) => clean(x, 60)).filter(Boolean).slice(0, 9);
  const d = { ...base };
  for (const [k, v] of Object.entries({
    business: pick(b.business, 100), industry: pick(b.industry, 60), area: pick(b.area, 160),
    phone: pick(b.phone, 30), email: pick(b.email, 120), address: pick(b.address, 200),
  })) if (v !== undefined) d[k] = v;
  if (b.description) d.about = String(b.description).slice(0, 1200);
  if (b.hours) d.hours = clean(b.hours, 300);
  // "Name: details" per line (or a comma list), like the admin forms.
  if (b.services) {
    const raw = String(b.services);
    d.services = (/\n/.test(raw.trim()) ? raw.split(/\r?\n/) : raw.split(/,\s*/))
      .map((l) => l.trim()).filter(Boolean).slice(0, 9)
      .map((l) => { const i = l.indexOf(":"); return i > 0 ? { name: clean(l.slice(0, i), 60), desc: clean(l.slice(i + 1), 220) } : { name: clean(l, 60) }; });
  }
  // Their kind of business: badges, an order/booking button, short facts, and a menu for food & drink.
  const type = businessTypes.typeById(b.type);
  if (type) {
    const extras = businessTypes.cleanExtras(type.id, b.extras);
    d.badges = extras.checks;
    d.ctaLink = extras.link;
    d.typeFacts = extras.facts;
    if (type.menu) d.menu = startExtras.parseMenu(b.menu);
  }
  const color = colorFromWords(b.colors);
  if (color) d.color = color;
  if (["modern", "classic", "bold", "friendly"].includes(b.font)) d.font = b.font;
  if (b.logo && String(b.logo).length < 7_000_000) d.logoData = String(b.logo);
  // City for the headline: from the sample, or the first town in "Area you serve".
  if (!d.city && d.area) d.city = clean(d.area.split(/,|\band\b/)[0], 60);
  if (!d.business) d.business = "Your Business";
  // Their uploaded photos (as many as the plan allows), with what each one shows.
  const planForPhotos = plans.planById(b.plan) || plans.planById("launch");
  const photos = (Array.isArray(b.photos) ? b.photos : [])
    .filter((x) => String(x?.url || "").startsWith(`${SITE_URL}/simg/`) && /^[^\s"'<>]+$/.test(x.url))
    .slice(0, planForPhotos.photos);
  if (photos.length) {
    d.photoUrls = photos.map((x) => x.url);
    d.photoLabels = photos.map((x) => clean(x.label, 80));
  }
  const google = startExtras.cleanGoogle(b.google);
  let heroImage = "";
  if (d.heroSeparate ? !d.heroUrl : !(d.photoUrls || []).length && !google?.photos.length) {
    const key = await tradeImages.hasTradeImage(pool, d.industry);
    if (key) heroImage = `/trade-img/${key}.jpg`;
    else if (d.industry) tradeImages.ensureTradeImage(pool, openai, IMAGE_MODEL, d.industry);
  }
  // The plan they picked decides which pages exist; the preview shows one at a time.
  const plan = plans.planById(b.plan)?.id || "launch";
  const pages = planPages(plan);
  const page = pages.some((x) => x.id === b.page) ? b.page : "home";
  res.json({
    html: renderPreview({ slug: "draft", data: d }, { draft: true, heroImage, google, claimUrl: "#", plan, page }),
    pages: pages.map(({ id, label }) => ({ id, label })),
    page,
    tradePending: !heroImage && Boolean(tradeImages.tradeKey(d.industry)),
  });
});

// Prefills /start when someone claims their sample homepage.
app.get("/api/setup-waiver/:slug", async (req, res) => {
  const waiverCents = await setupWaiverFor(req.params.slug);
  res.json({ waiverCents, freeDays: waiverCents ? FREE_MONTH_DAYS : 0 });
});

app.get("/api/preview-info/:slug", async (req, res) => {
  const { rows } = await pool.query("SELECT data FROM prospects WHERE slug=$1", [req.params.slug]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const d = rows[0].data;
  res.json({
    business: d.business,
    industry: d.industry,
    description: d.about,
    services: (d.services || []).map((s) => (s.desc ? `${s.name}: ${s.desc}` : s.name)).join("\n"),
    area: d.area || [d.city, d.state].filter(Boolean).join(", "),
    googleUrl: d.googleMapsUrl || "",
    type: d.type || "",
    extras: d.extras || {},
    menu: (d.menu || []).length ? startExtras.menuToText(d.menu) : "",
    phone: d.phone,
    email: d.email,
    address: d.address,
    hours: d.hours,
    domain: d.website ? siteDomain(d.website) : "",
    domainStatus: d.website ? "have" : "need",
    contactName: d.contactName,
    contactEmail: d.email,
  });
});

function unsubPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | EDZ Solutions</title><link rel="stylesheet" href="/css/site.css"></head>
<body style="background:var(--bg-soft)"><main class="wrap" style="max-width:560px;padding:80px 20px;text-align:center"><img src="/img/edz-logo.png?v=4" alt="EDZ Solutions" style="max-width:220px;margin:0 auto 28px;display:block"><h1 style="font-size:1.7rem">${title}</h1>${body}</main></body></html>`;
}

app.get("/u/:token", async (req, res) => {
  const { rows } = await pool.query("SELECT email, status FROM prospects WHERE unsub_token=$1", [req.params.token]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).send(unsubPage("Link not found", "<p>This unsubscribe link isn't valid. Reply to the email with \"unsubscribe\" and we'll remove you.</p>"));
  if (rows[0].status === "unsubscribed") return res.send(unsubPage("You're unsubscribed", `<p>We won't email ${escapeHtml(rows[0].email)} again.</p>`));
  res.send(unsubPage("Unsubscribe", `<p>Stop all emails from EDZ Solutions to <strong>${escapeHtml(rows[0].email)}</strong>?</p><form method="post"><button class="btn" type="submit">Unsubscribe</button></form>`));
});

// The form above and mail apps' one-click List-Unsubscribe both POST here.
app.post("/u/:token", express.urlencoded({ extended: false }), async (req, res) => {
  const { rows } = await pool.query("UPDATE prospects SET status='unsubscribed' WHERE unsub_token=$1 RETURNING email", [req.params.token]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).send(unsubPage("Link not found", "<p>This unsubscribe link isn't valid. Reply to the email with \"unsubscribe\" and we'll remove you.</p>"));
  res.send(unsubPage("You're unsubscribed", `<p>We won't email ${escapeHtml(rows[0].email)} again.</p>`));
});

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`EDZ Solutions running on ${SITE_URL}`));
    // Outreach sends on weekdays inside OUTREACH_WINDOW, one email per mailbox every 10 minutes.
    setInterval(() => outreach.tick(pool, SITE_URL).catch((e) => console.error("outreach tick failed:", e)), 10 * 60 * 1000);
    // Bounce notices and replies in the outreach inboxes, every 15 minutes (first check a minute after start).
    const checkInboxes = () => inbox.checkAll(pool).catch((e) => console.error("inbox check failed:", e));
    setTimeout(checkInboxes, 60 * 1000);
    setInterval(checkInboxes, 15 * 60 * 1000);
  })
  .catch((err) => {
    console.error("database setup failed:", err);
    process.exit(1);
  });
