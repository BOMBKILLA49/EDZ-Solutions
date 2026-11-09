const path = require("path");
const crypto = require("crypto");
const express = require("express");
const zlib = require("zlib");
const OpenAI = require("openai");
const Stripe = require("stripe");
const catalog = require("./config/catalog");
const { pool, migrate } = require("./lib/db");
const { sendAlert } = require("./lib/mailer");

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
  res.json({ eachCents: q.eachCents, ...price, promo: promo ? { code: promo.code, label: promoLabel(promo) } : null, promoError: error || null });
});

// ---------- AI business card designer (OpenAI image model) ----------

const IMAGE_MODEL = "gpt-image-2.6-flare";
const CARD_SIZE = "1792x1024"; // 1.75:1, the exact shape of a 3.5 x 2 in card
const CARD_DPI = 512; // 1792 px / 3.5 in

function designPrompt(details, style) {
  const labels = { company: "Company", name: "Name", title: "Title", tagline: "Tagline", phone: "Phone", email: "Email", website: "Website" };
  const text = Object.entries(labels)
    .filter(([k]) => details[k])
    .map(([k, label]) => `${label}: ${details[k]}`)
    .join("\n");
  return `Design the FRONT of a horizontal 3.5 x 2 inch business card that will be laser engraved on a metal card.

Fill the entire image edge to edge with the flat card design, viewed straight on. No mockup, no hands, no table, no shadows, no perspective, no card shape sitting on a background.
Monochrome only: black, white and shades of gray, in a detailed engraved-metal style. No color.

Put exactly this text on the card, spelled exactly as written, and nothing else for contact details:
${text}

The customer's style request: ${style || "clean, modern and professional"}

Do not draw a QR code or barcode. Do not use any brand logo or trademark other than this customer's own business name. Keep all text at least 6% in from every edge so nothing is cut off.`;
}

// Stamp the JPEG with its real print resolution so laser software imports it at 3.5 x 2 in.
function withDpi(jpeg, dpi) {
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

async function runDesign({ prompt, previous }) {
  let result;
  const started = Date.now();
  try {
    const params = { model: IMAGE_MODEL, prompt, size: CARD_SIZE, quality: "medium", output_format: "jpeg", output_compression: 90 };
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
  const style = clean(req.body.style, 600);
  const revision = clean(req.body.revision, 600);

  let previous = null;
  let prompt = designPrompt(details, style);
  if (req.body.previousDesignId && revision) {
    const { rows } = await pool.query("SELECT image FROM designs WHERE id=$1", [req.body.previousDesignId]).catch(() => ({ rows: [] }));
    if (!rows[0]) return res.status(404).json({ error: "That design expired. Please create it again." });
    previous = rows[0].image;
    prompt = `Edit this business card design. Change only what is asked and keep everything else the same: ${revision}

Keep it monochrome (black, white and grays), flat and edge to edge. Keep every word, number and email spelled exactly as it is now unless the change asks otherwise:
${Object.values(details).filter(Boolean).join(" | ")}`;
  }

  for (const [id, job] of designJobs) if (Date.now() - job.createdAt > JOB_TTL_MS) designJobs.delete(id);
  const id = crypto.randomUUID();
  const job = { createdAt: Date.now(), status: "working" };
  designJobs.set(id, job);
  runDesign({ prompt, previous }).then(
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

// ---------- business card checkout ----------

app.post("/api/checkout", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Online checkout isn't switched on yet." });
  const quote = catalog.quoteCard(req.body || {});
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
              name: `${quote.qty} metal business cards — ${quote.thickness.label}, ${quote.finish.label}`,
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
                           design_type, upload_name, upload_mime, upload_data, promo_code, discount_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [order.id, session.id, order.details, quote.thickness.id, quote.finish.id, quote.qty, price.totalCents,
       order.watchLive, order.tiktok, order.notes, design.type, order.upload.name, order.upload.mime, order.upload.data,
       promo?.code || null, price.discountCents]
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

function designFile(order) {
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "application/pdf": "pdf" }[order.upload_mime] || "bin";
  const kind = order.design_type === "ai" ? "ai-design" : "upload";
  return { filename: `EDZ-${order.id.slice(0, 8)}-${kind}.${ext}`, contentType: order.upload_mime, content: order.upload_data };
}

async function sendOrderAlert(o) {
  const d = o.details || {};
  const addr = o.shipping?.address;
  const shipTo = addr ? [o.shipping.name, addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postal_code}`].filter(Boolean).join("\n") : "(none)";
  const lines = [
    `NEW PAID ORDER — $${(o.total_cents / 100).toFixed(2)}`,
    ``,
    `${o.qty} cards · ${o.thickness} mm · ${FINISH_LABEL[o.finish] || o.finish}`,
    o.promo_code ? `Promo: ${o.promo_code} (saved $${(o.discount_cents / 100).toFixed(2)})` : null,
    `Design: ${o.design_type === "ai" ? "AI design (image attached, 3.5 x 2 in at 512 DPI)" : `customer upload (${o.upload_name})`}`,
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
    attachments: [designFile(o)],
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
  const given = scheme === "Basic" ? Buffer.from(encoded || "", "base64").toString().split(":").slice(1).join(":") : "";
  const ok = given.length === pass.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pass));
  if (ok) return next();
  res.set("WWW-Authenticate", 'Basic realm="EDZ orders"').status(401).send("Password required.");
}

app.get("/admin", requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "views", "admin.html")));

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, created_at, paid_at, status, details, thickness, finish, qty, total_cents, watch_live, tiktok, notes,
            design_type, promo_code, discount_cents, upload_name, upload_mime, customer_email, customer_name, customer_phone, shipping
     FROM orders WHERE status <> 'pending_payment' ORDER BY paid_at DESC LIMIT 200`
  );
  const { rows: inquiries } = await pool.query("SELECT created_at, data FROM inquiries ORDER BY created_at DESC LIMIT 50");
  res.json({ orders: rows, inquiries, finishes: FINISH_LABEL });
});

app.get("/api/admin/orders/:id/design", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).send("Not found");
  const f = designFile(rows[0]);
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
