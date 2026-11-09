const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");
const catalog = require("./config/catalog");
const { pool, migrate } = require("./lib/db");
const { sendAlert } = require("./lib/mailer");

const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
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

// The SVG is shown in <img> tags (scripts never run there), but strip anything
// active anyway before storing or sending it anywhere.
function sanitizeSvg(svg) {
  let s = String(svg || "");
  const start = s.indexOf("<svg");
  const end = s.lastIndexOf("</svg>");
  if (start === -1 || end === -1) return null;
  s = s.slice(start, end + 6);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  s = s.replace(/<(image|use|a)\b[^>]*\/?>/gi, "").replace(/<\/(a)>/gi, "");
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "");
  s = s.replace(/(href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  if (!/^<svg[^>]*xmlns=/.test(s)) s = s.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
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
    aiEnabled: Boolean(anthropic),
    checkoutEnabled: Boolean(stripe),
  });
});

app.post("/api/price", (req, res) => {
  const q = catalog.quoteCard(req.body || {});
  if (!q) return res.status(400).json({ error: "Pick a thickness, finish and quantity." });
  res.json({ eachCents: q.eachCents, totalCents: q.totalCents });
});

// ---------- AI business card designer ----------

const DESIGN_SYSTEM = `You design business cards that are laser engraved onto metal by a fiber laser.

Output one SVG for the FRONT of a 3.5 x 2 inch card.
- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1050 600">. No width/height attributes.
- Everything you draw is engraved. Use ONLY fill="#000" and/or stroke="#000". No other colors, no gradients, no opacity, no filters, no patterns, no <image>, no external references, no <style> blocks, no scripts.
- Do not draw a background rectangle; the bare metal is the background.
- Fonts: font-family must be one of sans-serif, serif, monospace (optionally with font-weight). No web fonts.
- Keep all content at least 45 units inside every edge. Smallest text is font-size 22. Lines and strokes are at least 2 units wide.
- Use every contact detail provided exactly as written, spelled exactly. Leave out fields that are empty. Never invent phone numbers, emails or names.
- Simple geometric shapes, rules, borders and line icons (phone, mail, globe) drawn with paths are welcome. A simple monogram or mark built from the company initials is fine. Never reproduce another company's logo or trademark.
- Make it look professionally designed: clear hierarchy, aligned edges, generous spacing, nothing overlapping.

Also return a short one-sentence note describing the design.`;

const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    svg: { type: "string" },
    note: { type: "string" },
  },
  required: ["svg", "note"],
  additionalProperties: false,
};

app.post("/api/design", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "The AI designer isn't switched on yet." });
  if (rateLimited(req.ip)) return res.status(429).json({ error: "Design limit reached for now. Try again in an hour." });

  const details = cardDetails(req.body);
  if (!details.name && !details.company) {
    return res.status(400).json({ error: "Add at least a name or company." });
  }
  const style = clean(req.body.style, 600);
  const previousSvg = req.body.previousSvg ? sanitizeSvg(clean(req.body.previousSvg, 60000)) : null;
  const revision = clean(req.body.revision, 600);

  const lines = Object.entries(details)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  let prompt = `Card details:\n${lines}\n\nStyle the customer asked for: ${style || "clean, modern, professional"}`;
  if (previousSvg && revision) {
    prompt += `\n\nHere is the current design:\n${previousSvg}\n\nRevise it: ${revision}`;
  }

  try {
    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: DESIGN_SYSTEM,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: DESIGN_SCHEMA },
      },
      messages: [{ role: "user", content: prompt }],
    });

    const u = response.usage;
    const cost = (u.input_tokens * 5 + u.output_tokens * 25) / 1e6;
    console.log(`design: ${u.input_tokens} in / ${u.output_tokens} out tokens, ~$${cost.toFixed(3)}`);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "That design request can't be made. Try describing it differently." });
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(text);
    const svg = sanitizeSvg(parsed.svg);
    if (!svg) throw new Error("No SVG in response");
    res.json({ svg, note: clean(parsed.note, 300) });
  } catch (err) {
    console.error("design error:", err);
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(503).json({ error: "The designer is busy. Try again in a minute." });
    }
    res.status(500).json({ error: "The designer hit a snag. Please try again." });
  }
});

// ---------- business card checkout ----------

app.post("/api/checkout", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Online checkout isn't switched on yet." });
  const quote = catalog.quoteCard(req.body || {});
  if (!quote) return res.status(400).json({ error: "Pick a thickness, finish and quantity." });

  const design = req.body.design || {};
  const order = {
    id: crypto.randomUUID(),
    details: cardDetails(req.body),
    watchLive: Boolean(req.body.watchLive),
    tiktok: clean(req.body.tiktok, 40),
    notes: clean(req.body.notes, 1000),
  };

  if (design.type === "ai") {
    order.svg = sanitizeSvg(design.svg);
    if (!order.svg) return res.status(400).json({ error: "Create a design first." });
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
      line_items: [
        {
          quantity: quote.qty,
          price_data: {
            currency: "usd",
            unit_amount: quote.eachCents,
            product_data: {
              name: `Metal business cards — ${quote.thickness.label}, ${quote.finish.label}`,
              description: order.watchLive ? "Engraved live on TikTok" : "Custom laser engraved",
            },
          },
        },
      ],
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      client_reference_id: order.id,
      metadata: { order_id: order.id, thickness: quote.thickness.id, finish: quote.finish.id, qty: String(quote.qty), tiktok: order.tiktok },
      success_url: `${SITE_URL}/order-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/business-cards`,
    });

    await pool.query(
      `INSERT INTO orders (id, stripe_session, details, thickness, finish, qty, total_cents, watch_live, tiktok, notes,
                           design_type, svg, upload_name, upload_mime, upload_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [order.id, session.id, order.details, quote.thickness.id, quote.finish.id, quote.qty, quote.totalCents,
       order.watchLive, order.tiktok, order.notes, design.type, order.svg || null,
       order.upload?.name || null, order.upload?.mime || null, order.upload?.data || null]
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
  if (rows[0]) await sendOrderAlert(rows[0]).catch((e) => console.error("alert email failed:", e));
  return rows[0] || null;
}

const FINISH_LABEL = Object.fromEntries(catalog.cardFinish.map((f) => [f.id, f.label]));
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function designFile(order) {
  if (order.design_type === "ai") {
    return { filename: `EDZ-${order.id.slice(0, 8)}.svg`, contentType: "image/svg+xml", content: laserSvg(order.svg) };
  }
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "application/pdf": "pdf" }[order.upload_mime] || "bin";
  return { filename: `EDZ-${order.id.slice(0, 8)}-upload.${ext}`, contentType: order.upload_mime, content: order.upload_data };
}

// Real-world size so the file imports into laser software at exactly 3.5 x 2 in.
function laserSvg(svg) {
  return svg.replace(/<svg\b([^>]*)>/, (m, attrs) =>
    `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} width="88.9mm" height="50.8mm">`);
}

async function sendOrderAlert(o) {
  const d = o.details || {};
  const addr = o.shipping?.address;
  const shipTo = addr ? [o.shipping.name, addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postal_code}`].filter(Boolean).join("\n") : "(none)";
  const lines = [
    `NEW PAID ORDER — $${(o.total_cents / 100).toFixed(2)}`,
    ``,
    `${o.qty} cards · ${o.thickness} mm · ${FINISH_LABEL[o.finish] || o.finish}`,
    `Design: ${o.design_type === "ai" ? "AI design (SVG attached, sized 3.5 x 2 in)" : `customer upload (${o.upload_name})`}`,
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
            design_type, svg, upload_name, upload_mime, customer_email, customer_name, customer_phone, shipping
     FROM orders WHERE status <> 'pending_payment' ORDER BY paid_at DESC LIMIT 200`
  );
  const { rows: inquiries } = await pool.query("SELECT created_at, data FROM inquiries ORDER BY created_at DESC LIMIT 50");
  res.json({ orders: rows, inquiries, finishes: FINISH_LABEL });
});

app.get("/api/admin/orders/:id/design", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) return res.status(404).send("Not found");
  const f = designFile(rows[0]);
  res.set("Content-Type", f.contentType).attachment(f.filename).send(f.content);
});

app.post("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const status = String(req.body.status || "");
  if (!["paid", "engraved", "shipped"].includes(status)) return res.status(400).json({ error: "Bad status" });
  await pool.query("UPDATE orders SET status=$2 WHERE id=$1 AND status <> 'pending_payment'", [req.params.id, status]);
  res.json({ ok: true });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`EDZ Solutions running on ${SITE_URL}`)))
  .catch((err) => {
    console.error("database setup failed:", err);
    process.exit(1);
  });
