const path = require("path");
const crypto = require("crypto");
const express = require("express");
const OpenAI = require("openai");
const Stripe = require("stripe");
const catalog = require("./config/catalog");
const shipping = require("./config/shipping");
const plans = require("./config/plans");
const { pool, migrate } = require("./lib/db");
const { sendAlert } = require("./lib/mailer");
const cardback = require("./lib/cardback");
const { withDpi, imageMime, normalizeUrl } = cardback;
const { ZipWriter } = require("./lib/zip");

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

function promoLabel(p) {
  if (!p) return null;
  if (p.kind === "percent") return `${p.value}% off`;
  if (p.kind === "amount") return `$${(p.value / 100).toFixed(2)} off`;
  return `Order total $${(p.value / 100).toFixed(2)}`;
}

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
  const { promo, error } = await findPromo(req.body.promo);
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

function designPrompt(details, style) {
  const labels = { company: "Company", name: "Name", title: "Title", tagline: "Tagline", phone: "Phone", email: "Email", website: "Website" };
  const text = Object.entries(labels)
    .filter(([k]) => details[k])
    .map(([k, label]) => `${label}: ${details[k]}`)
    .join("\n");
  return `Design the FRONT of a horizontal 3.375 x 2.125 inch (credit-card size) business card that will be laser engraved on a metal card.

Fill the entire image edge to edge with the flat card design, viewed straight on. No mockup, no hands, no table, no shadows, no perspective, no card shape sitting on a background.
${ENGRAVING_RULES}

Put exactly this text on the card, spelled exactly as written, and nothing else for contact details:
${text}

The customer's style request: ${style || "clean, modern and professional"}

Do not draw a QR code or barcode. Do not use any brand logo or trademark other than this customer's own business name. Keep all text at least 6% in from every edge so nothing is cut off.`;
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

async function runDesign({ prompt, previous, size = CARD_SIZE }) {
  let result;
  const started = Date.now();
  try {
    const params = { model: IMAGE_MODEL, prompt, size, quality: "medium", output_format: "jpeg", output_compression: 90 };
    result = previous
      ? await openai.images.edit({ ...params, image: await OpenAI.toFile(previous, "design.jpg", { type: imageMime(previous) }) })
      : await openai.images.generate(params);
  } catch (err) {
    console.error("design error:", err.status, err.code, err.message);
    if (err.code === "moderation_blocked" || err.code === "content_policy_violation") {
      throw new DesignError(422, "That design request can't be made. Try describing it differently.");
    }
    if (err.status === 429) throw new DesignError(503, "The designer is busy. Try again in a minute.");
    throw new DesignError(500, "The designer hit a snag. Please try again.");
  }
  console.log(`design: ${previous ? "edit" : "new"} in ${((Date.now() - started) / 1000).toFixed(0)}s, usage ${JSON.stringify(result.usage)}`);

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
    prompt = wedding ? weddingPrompt(details, style, guestMode) : designPrompt(details, style);
  }

  for (const [id, job] of designJobs) if (Date.now() - job.createdAt > JOB_TTL_MS) designJobs.delete(id);
  const id = crypto.randomUUID();
  const job = { createdAt: Date.now(), status: "working" };
  designJobs.set(id, job);
  runDesign({ prompt, previous, size: side === "back" ? "1024x1024" : CARD_SIZE }).then(
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

  const { promo, error: promoError } = await findPromo(req.body.promo);
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
              name: `${quote.qty} ${wedding ? (guests ? "metal wedding place cards (one per guest)" : "metal wedding cards") : "metal business cards"} — ${quote.thickness.label}, ${quote.finish.label}${order.back ? ", front & back" : ""}`,
              description: [
                order.watchLive ? "Engraved live on TikTok" : "Custom laser engraved",
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
      client_reference_id: order.id,
      metadata: { order_id: order.id, product: wedding ? "wedding" : "business", promo: promo?.code || "", thickness: quote.thickness.id, finish: quote.finish.id, qty: String(quote.qty), tiktok: order.tiktok },
      success_url: `${SITE_URL}/order-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/${wedding ? "wedding-cards" : "business-cards"}`,
    });

    await pool.query(
      `INSERT INTO orders (id, stripe_session, details, thickness, finish, qty, total_cents, watch_live, tiktok, notes,
                           design_type, upload_name, upload_mime, upload_data, promo_code, discount_cents,
                           back_mode, back_name, back_mime, back_data, qr_url, shipping_cents, ship_dest,
                           product, guest_names, name_font)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [order.id, session.id, order.details, quote.thickness.id, quote.finish.id, quote.qty, price.totalCents,
       order.watchLive, order.tiktok, order.notes, design.type, order.upload.name, order.upload.mime, order.upload.data,
       promo?.code || null, price.discountCents,
       backMode, order.back?.name || null, order.back?.mime || null, order.back?.data || null, order.qrUrl || null,
       ship.cents, dest,
       wedding ? "wedding" : "business", guests ? JSON.stringify(guests) : null, guests ? nameFont(req.body.font) : null]
    );
    res.json({ url: session.url });
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
    powerFeatures: plans.POWER_FEATURES,
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
    likes: clean(b.likes, 1000),
    feature: plan.id === "business" ? clean(b.feature, 40) : null,
    notes: clean(b.notes, 3000),
    contactName: clean(b.contactName, 120),
    contactEmail: clean(b.contactEmail, 120),
    contactPhone: clean(b.contactPhone, 40),
  };
  if (!data.business) return res.status(400).json({ error: "Add your business name." });
  if (!data.contactName || !/^\S+@\S+\.\S+$/.test(data.contactEmail)) return res.status(400).json({ error: "Add your name and a valid email so we can reach you." });
  if (plan.id === "business" && !plans.POWER_FEATURES.some((f) => f.id === data.feature)) return res.status(400).json({ error: "Pick your power feature." });

  let logo = null;
  if (b.logo?.dataUrl) {
    const m = /^data:(image\/(png|jpeg|svg\+xml)|application\/pdf);base64,(.*)$/s.exec(b.logo.dataUrl);
    if (!m) return res.status(400).json({ error: "Logo must be a PNG, JPG, SVG or PDF." });
    logo = { mime: m[1], name: clean(b.logo.name, 120), data: Buffer.from(m[3], "base64") };
  }

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
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: plan.setupCents,
            product_data: { name: `${plan.name} website setup (one time)` },
          },
        },
      ],
      subscription_data: {
        trial_period_days: plan.trialDays,
        description: `${plan.name} website plan for ${data.business}`,
        metadata: { project_id: id, plan: plan.id },
      },
      customer_email: data.contactEmail,
      metadata: { kind: "website", project_id: id, plan: plan.id },
      custom_text: {
        submit: { message: `You pay the ${(plan.setupCents / 100).toFixed(0)} dollar setup today. The monthly plan starts in ${plan.trialDays} days, around when your site goes live. Cancel anytime.` },
      },
      success_url: `${SITE_URL}/project-started?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/start?plan=${plan.id}`,
    });
    await pool.query(
      `INSERT INTO projects (id, plan, stripe_session, data, logo_name, logo_mime, logo_data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, plan.id, session.id, data, logo?.name || null, logo?.mime || null, logo?.data || null]
    );
    res.json({ url: session.url });
  } catch (err) {
    console.error("plan checkout error:", err);
    res.status(500).json({ error: "Checkout couldn't start. Please try again." });
  }
});

// Marks a website project paid exactly once, then emails the project details.
async function markProjectPaid(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!["paid", "no_payment_required"].includes(session.payment_status)) return null;
  const cust = session.customer_details || {};
  const { rows } = await pool.query(
    `UPDATE projects SET status='new', paid_at=now(), stripe_subscription=$2, stripe_customer=$3, customer_email=$4, customer_name=$5
     WHERE stripe_session=$1 AND status='pending_payment' RETURNING *`,
    [sessionId, session.subscription || null, session.customer || null, cust.email || null, cust.name || null]
  );
  if (rows[0]) await sendProjectAlert(rows[0]).catch((e) => console.error("project alert failed:", e));
  return rows[0] || null;
}

async function sendProjectAlert(p) {
  const plan = plans.planById(p.plan);
  const d = p.data || {};
  const feature = plans.POWER_FEATURES.find((f) => f.id === d.feature);
  const lines = [
    `NEW WEBSITE PROJECT — ${plan.name} ($${(plan.setupCents / 100).toFixed(2)} setup paid, $${(plan.monthlyCents / 100).toFixed(2)}/mo starts in ${plan.trialDays} days)`,
    `Deliver by: ${plan.delivery.replace(/^Live in /, "")}`,
    plan.cards ? `Includes: ${plan.cards} free metal business cards` : null,
    ``,
    `Business: ${d.business}${d.industry ? ` (${d.industry})` : ""}`,
    d.description ? `About: ${d.description}` : null,
    d.services ? `Services: ${d.services}` : null,
    d.area ? `Service area: ${d.area}` : null,
    feature ? `Power feature: ${feature.label}` : null,
    `Domain: ${d.domainStatus === "need" ? `NEEDS ONE${d.domain ? ` (wants ${d.domain})` : ""}` : d.domain || "(not given)"}`,
    d.colors ? `Colors: ${d.colors}` : null,
    d.likes ? `Sites they like: ${d.likes}` : null,
    ``,
    `On the site — phone: ${d.phone || "-"} · email: ${d.email || "-"} · address: ${d.address || "-"}`,
    d.hours ? `Hours: ${d.hours}` : null,
    d.notes ? `Notes: ${d.notes}` : null,
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

app.get("/admin", requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "views", "admin.html")));

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, created_at, paid_at, status, details, thickness, finish, qty, total_cents, watch_live, tiktok, notes,
            design_type, product, guest_names, name_font, promo_code, discount_cents, back_mode, qr_url, shipping_cents, ship_dest, ship_flag, (back_data IS NOT NULL) AS has_back, back_name, back_mime, upload_name, upload_mime, customer_email, customer_name, customer_phone, shipping
     FROM orders WHERE status <> 'pending_payment' ORDER BY paid_at DESC LIMIT 200`
  );
  const { rows: inquiries } = await pool.query("SELECT created_at, data FROM inquiries ORDER BY created_at DESC LIMIT 50");
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
  try {
    await pool.query("INSERT INTO promos (code, kind, value, max_uses, note) VALUES ($1,$2,$3,$4,$5)", [code, kind, value, maxUses, clean(b.note, 120) || null]);
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

app.get("/api/admin/projects", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, created_at, paid_at, status, plan, stripe_subscription, data, logo_name, customer_email, customer_name
     FROM projects WHERE status <> 'pending_payment' ORDER BY paid_at DESC LIMIT 200`
  );
  res.json({ projects: rows.map((p) => ({ ...p, planName: plans.planById(p.plan)?.name || p.plan })), powerFeatures: plans.POWER_FEATURES });
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

migrate()
  .then(() => app.listen(PORT, () => console.log(`EDZ Solutions running on ${SITE_URL}`)))
  .catch((err) => {
    console.error("database setup failed:", err);
    process.exit(1);
  });
