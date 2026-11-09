const path = require("path");
const crypto = require("crypto");
const express = require("express");
const OpenAI = require("openai");
const Stripe = require("stripe");
const catalog = require("./config/catalog");
const { pool, migrate } = require("./lib/db");
const { sendAlert } = require("./lib/mailer");
const cardback = require("./lib/cardback");
const { withDpi, imageMime, normalizeUrl } = cardback;

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
      await markPaid(event.data.object.id);
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

app.post("/api/price", async (req, res) => {
  const q = catalog.quoteCard(req.body || {});
  if (!q) return res.status(400).json({ error: "Pick a thickness, finish and quantity." });
  const { promo, error } = await findPromo(req.body.promo);
  const price = applyPromo(q, promo);
  res.json({ eachCents: q.eachCents, frontCents: q.frontCents, backCents: q.backCents, ...price, promo: promo ? { code: promo.code, label: promoLabel(promo) } : null, promoError: error || null });
});

// ---------- AI business card designer (OpenAI image model) ----------

const IMAGE_MODEL = "gpt-image-2.6-flare";
const CARD_SIZE = "1792x1024"; // 1.75:1, the exact shape of a 3.5 x 2 in card
const CARD_DPI = cardback.DPI; // 1792 px / 3.5 in

// Dark pixels are what the laser engraves, so art is always dark on a light background.
const ENGRAVING_RULES = `Plain white or very light background. Draw the design in black and dark gray only, in a detailed engraved style. No color.`;

function designPrompt(details, style) {
  const labels = { company: "Company", name: "Name", title: "Title", tagline: "Tagline", phone: "Phone", email: "Email", website: "Website" };
  const text = Object.entries(labels)
    .filter(([k]) => details[k])
    .map(([k, label]) => `${label}: ${details[k]}`)
    .join("\n");
  return `Design the FRONT of a horizontal 3.5 x 2 inch business card that will be laser engraved on a metal card.

Fill the entire image edge to edge with the flat card design, viewed straight on. No mockup, no hands, no table, no shadows, no perspective, no card shape sitting on a background.
${ENGRAVING_RULES}

Put exactly this text on the card, spelled exactly as written, and nothing else for contact details:
${text}

The customer's style request: ${style || "clean, modern and professional"}

Do not draw a QR code or barcode. Do not use any brand logo or trademark other than this customer's own business name. Keep all text at least 6% in from every edge so nothing is cut off.`;
}

// The AI only draws a square panel for the right side of the back; the site puts the
// real QR code beside it (see lib/cardback.js), so the art can never cover the code.
function backPrompt(details, style, caption, fromFront) {
  const name = details.company || details.name;
  return `${fromFront ? "This image is the FRONT of a business card. Use it only as a style reference (same fonts, line work and illustration style) and design" : "Design"} a SQUARE artwork panel for the back of a business card that will be laser engraved on metal. A QR code will be placed to the left of this panel, so do not draw a QR code, barcode or card border.

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

  const details = cardDetails(req.body);
  if (!details.name && !details.company) {
    return res.status(400).json({ error: "Add at least a name or company." });
  }
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
    prompt = `Edit this business card design. Change only what is asked and keep everything else the same: ${revision}

Keep it flat and edge to edge. ${ENGRAVING_RULES} Keep every word, number and email spelled exactly as it is now unless the change asks otherwise:
${[...Object.values(details), caption].filter(Boolean).join(" | ")}${side === "back" ? "\nKeep it a square panel with no QR code and no border." : ""}`;
  } else if (side === "back") {
    // Base the back on the front design when there is one, so the two sides match.
    previous = req.body.frontDesignId ? await loadDesign(req.body.frontDesignId) : null;
    prompt = backPrompt(details, style, caption, Boolean(previous));
  } else {
    prompt = designPrompt(details, style);
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
  const finish = catalog.cardFinish.some((f) => f.id === req.query.finish) ? req.query.finish : "mirror";
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
  const quote = catalog.quoteCard({ ...req.body, back: backMode !== "none" });
  if (!quote) return res.status(400).json({ error: "Pick a thickness, finish and quantity." });

  const { promo, error: promoError } = await findPromo(req.body.promo);
  if (promoError) return res.status(400).json({ error: promoError });
  const price = applyPromo(quote, promo);

  const design = req.body.design || {};
  const order = {
    id: crypto.randomUUID(),
    details: cardDetails(req.body),
    watchLive: Boolean(req.body.watchLive),
    tiktok: clean(req.body.tiktok, 40),
    notes: clean(req.body.notes, 1000),
  };

  if (design.type === "ai") {
    const { rows } = await pool.query("SELECT image FROM designs WHERE id=$1", [design.designId]).catch(() => ({ rows: [] }));
    if (!rows[0]) return res.status(400).json({ error: "Create a design first." });
    const mime = imageMime(rows[0].image);
    order.upload = { mime, name: mime === "image/png" ? "ai-design.png" : "ai-design.jpg", data: rows[0].image };
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
      company: order.details.company || order.details.name,
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
              name: `${quote.qty} metal business cards — ${quote.thickness.label}, ${quote.finish.label}${order.back ? ", front & back" : ""}`,
              description: [
                order.watchLive ? "Engraved live on TikTok" : "Custom laser engraved",
                promo ? `Promo ${promo.code}: ${promoLabel(promo)}` : null,
              ].filter(Boolean).join(" · "),
            },
          },
        },
      ],
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      client_reference_id: order.id,
      metadata: { order_id: order.id, promo: promo?.code || "", thickness: quote.thickness.id, finish: quote.finish.id, qty: String(quote.qty), tiktok: order.tiktok },
      success_url: `${SITE_URL}/order-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/business-cards`,
    });

    await pool.query(
      `INSERT INTO orders (id, stripe_session, details, thickness, finish, qty, total_cents, watch_live, tiktok, notes,
                           design_type, upload_name, upload_mime, upload_data, promo_code, discount_cents,
                           back_mode, back_name, back_mime, back_data, qr_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [order.id, session.id, order.details, quote.thickness.id, quote.finish.id, quote.qty, price.totalCents,
       order.watchLive, order.tiktok, order.notes, design.type, order.upload.name, order.upload.mime, order.upload.data,
       promo?.code || null, price.discountCents,
       backMode, order.back?.name || null, order.back?.mime || null, order.back?.data || null, order.qrUrl || null]
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
  const { rows } = await pool.query(
    `UPDATE orders SET status='paid', paid_at=now(), customer_email=$2, customer_name=$3, customer_phone=$4, shipping=$5
     WHERE stripe_session=$1 AND status='pending_payment' RETURNING *`,
    [sessionId, cust.email || null, ship?.name || cust.name || null, cust.phone || null, ship]
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

async function sendOrderAlert(o) {
  const d = o.details || {};
  const addr = o.shipping?.address;
  const shipTo = addr ? [o.shipping.name, addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postal_code}`].filter(Boolean).join("\n") : "(none)";
  const lines = [
    `NEW PAID ORDER — $${(o.total_cents / 100).toFixed(2)}`,
    ``,
    `${o.qty} cards · ${o.thickness} mm · ${FINISH_LABEL[o.finish] || o.finish}`,
    o.promo_code ? `Promo: ${o.promo_code} (saved $${(o.discount_cents / 100).toFixed(2)})` : null,
    `Front: ${o.design_type === "ai" ? "AI design" : `customer upload (${o.upload_name})`}`,
    `Back: ${BACK_LABEL[o.back_mode] || "blank"}${o.qr_url ? ` — QR goes to ${o.qr_url}` : ""}`,
    `Files attached are 3.5 x 2 in at 512 DPI. The dark parts of each file are what gets engraved.`,
    `Watch live: ${o.watch_live ? `YES${o.tiktok ? ` — ${o.tiktok}` : ""}` : "no"}`,
    o.notes ? `Notes: ${o.notes}` : null,
    ``,
    `Card text: ${[d.name, d.title, d.company, d.phone, d.email, d.website, d.tagline].filter(Boolean).join(" | ")}`,
    ``,
    `Customer: ${o.customer_name || ""} · ${o.customer_email || ""} · ${o.customer_phone || ""}`,
    `Ship to:\n${shipTo}`,
    ``,
    `Orders: ${SITE_URL}/admin`,
  ].filter((l) => l !== null);
  const text = lines.join("\n");
  await sendAlert({
    subject: `New card order: ${o.qty} × ${FINISH_LABEL[o.finish] || o.finish} — ${o.customer_name || d.name || "customer"}`,
    text,
    html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    attachments: [designFile(o, "front"), designFile(o, "back")].filter(Boolean),
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
            design_type, promo_code, discount_cents, back_mode, qr_url, (back_data IS NOT NULL) AS has_back, back_name, back_mime, upload_name, upload_mime, customer_email, customer_name, customer_phone, shipping
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

migrate()
  .then(() => app.listen(PORT, () => console.log(`EDZ Solutions running on ${SITE_URL}`)))
  .catch((err) => {
    console.error("database setup failed:", err);
    process.exit(1);
  });
