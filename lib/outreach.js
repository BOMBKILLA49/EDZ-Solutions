// Cold outreach email: one email per prospect showing a screenshot of the sample
// homepage we built for them (/p/<slug>), plus a metal business card pitch.
// Sent from separate outreach domains' mailboxes (OUTREACH_MAILBOXES) so spam complaints
// can't hurt edzsolutions.com, where order alerts and customer email live.

const nodemailer = require("nodemailer");
const plans = require("../config/plans");
const catalog = require("../config/catalog");
const { esc } = require("./preview");

const env = (k, d = "") => (process.env[k] || d).trim();

// Outreach mailboxes, one per line of OUTREACH_MAILBOXES (JSON array):
//   [{ "user": "info@edzsolutions.site", "pass": "...", "start": "2026-11-15", "max": 30 }, ...]
// Each sends at most its warm-up limit per 24 h: 5 on its first day, +2 a day, up to `max`.
// The single-mailbox OUTREACH_SMTP_USER / OUTREACH_SMTP_PASS settings still work as one mailbox.
function mailboxes() {
  let list = [];
  try {
    list = JSON.parse(env("OUTREACH_MAILBOXES", "[]"));
  } catch {
    console.error("OUTREACH_MAILBOXES isn't valid JSON");
  }
  if (!list.length && env("OUTREACH_SMTP_USER")) {
    list = [{ user: env("OUTREACH_SMTP_USER"), pass: env("OUTREACH_SMTP_PASS"), start: env("OUTREACH_START", "2026-11-15") }];
  }
  return list
    .filter((m) => m.user && m.pass)
    .map((m) => ({ ...m, user: m.user.toLowerCase(), from: m.from || `${env("OUTREACH_FROM_NAME", "Ty at EDZ Solutions")} <${m.user}>` }));
}

function warmupLimit(m, now = new Date()) {
  const days = Math.max(0, Math.floor((now - new Date(`${m.start || "2026-11-15"}T00:00:00Z`)) / 864e5));
  return Math.min(Number(m.max) || 30, 5 + 2 * days);
}

const settings = () => ({
  senderName: env("OUTREACH_SENDER_NAME"),
  phone: env("OUTREACH_PHONE"),
  address: env("OUTREACH_ADDRESS"), // postal address, required by CAN-SPAM
  dailyLimit: Math.max(0, Number(env("OUTREACH_DAILY_LIMIT", "50")) || 0), // all mailboxes together
  paused: env("OUTREACH_PAUSED") === "1",
  // Sends only go out on weekdays inside this window, in OUTREACH_TZ (default US Central).
  tz: env("OUTREACH_TZ", "America/Chicago"),
  window: env("OUTREACH_WINDOW", "8-14").split("-").map(Number),
});

// Why sending is off, or null when it's ready.
function notReady() {
  const s = settings();
  if (s.paused) return "Outreach is paused (OUTREACH_PAUSED=1).";
  const missing = ["OUTREACH_SMTP_HOST", "OUTREACH_SENDER_NAME", "OUTREACH_ADDRESS"].filter((k) => !env(k));
  if (!mailboxes().length) missing.push("OUTREACH_MAILBOXES");
  return missing.length ? `Outreach email isn't set up. Missing: ${missing.join(", ")}` : null;
}

// Is it a weekday inside the sending window right now?
function inWindow(now = new Date()) {
  const s = settings();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: s.tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(parts.hour);
  return !["Sat", "Sun"].includes(parts.weekday) && hour >= s.window[0] && hour < s.window[1];
}

const transports = new Map();
function getTransport(m) {
  if (!transports.has(m.user)) {
    transports.set(m.user, nodemailer.createTransport({
      host: env("OUTREACH_SMTP_HOST"),
      port: Number(env("OUTREACH_SMTP_PORT", "465")),
      secure: Number(env("OUTREACH_SMTP_PORT", "465")) === 465,
      auth: { user: m.user, pass: m.pass },
    }));
  }
  return transports.get(m.user);
}

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";
const ACCENT = "#f59e0b";

function links(p, siteUrl) {
  const utm = "utm_source=outreach&utm_medium=email";
  return {
    preview: `${siteUrl}/p/${p.slug}?${utm}`,
    shot: `${siteUrl}/p/${p.slug}/shot.jpg`,
    claim: `${siteUrl}/start?plan=launch&preview=${p.slug}&${utm}`,
    cards: `${siteUrl}/business-cards?${utm}`,
    unsub: `${siteUrl}/u/${p.unsub_token}`,
  };
}

function buildEmail(p, siteUrl) {
  const s = settings();
  const d = p.data || {};
  const L = links(p, siteUrl);
  const launch = plans.planById("launch");
  const cardFrom = Math.min(...catalog.cardThickness.map((t) => t.perCard)) * 100;
  const hi = firstName(d.contactName) ? `Hi ${firstName(d.contactName)},` : "Hi there,";
  const noSite = !p.domain;
  const site = p.domain || "your website";
  // Where we found their email (shown in the footer, as the law expects us to say why they got it).
  const foundOn = noSite ? d.emailSource || "your public business listing" : site;
  const included = noSite ? "a free domain name, hosting and security" : "hosting, security and your domain hookup";
  // Google's category names ("Lawn care service", "Plumber") don't read well mid-sentence.
  const where = d.city ? `businesses in ${d.city}` : "local businesses";
  const subject = noSite ? `I built a website for ${d.business}` : `I made a new homepage for ${d.business}`;
  const intro = noSite
    ? `I was looking at ${where} and noticed ${d.business} doesn't have a website yet, so I built one for you using the info from ${foundOn}.`
    : `I came across ${site} while looking at ${where}, and I put together a modern homepage for ${d.business} using the info already on your site.`;
  const priceLine = `${money(launch.setupCents)} setup + ${money(launch.monthlyCents)}/month`;

  const benefits = [
    ["📱", "Made for phones.", "Most people looking for you are on one. It reads and works great on any screen."],
    ["📞", "Call and quote buttons up top.", "Visitors can reach you with one tap instead of hunting for your number."],
    ["🔎", "Ready for Google.", "Fast, secure (https) and set up so search engines understand what you do and where."],
    ["⚡", "Live in about 3 days.", "We handle hosting and hook up your domain. Changes are just an email away."],
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f2f2f2;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f2f2f2;">It's free to look at and already live. Here's what ${esc(d.business)}'s website could look like.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f2f2;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#222222;">

          <tr>
            <td style="background:#0f172a;padding:22px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;"><img src="${siteUrl}/img/edz-icon.png" width="36" height="36" alt="EDZ" style="display:block;border:0;border-radius:8px;"></td>
                  <td style="vertical-align:middle;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">EDZ <span style="color:${ACCENT};">Solutions</span></td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 28px 8px;">
              <div style="font-size:12px;font-weight:700;color:${ACCENT};text-transform:uppercase;letter-spacing:1px;">A free sample for ${esc(d.business)}</div>
              <h1 style="margin:10px 0 0;font-size:28px;line-height:1.2;font-weight:800;color:#111111;">${noSite ? `Here's a website for ${esc(d.business)}.` : `Here's a new homepage for ${esc(d.business)}.`}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 0;font-size:16px;line-height:1.6;color:#333333;">
              <p style="margin:0 0 14px;">${esc(hi)}</p>
              <p style="margin:0 0 14px;">${esc(intro)}${d.hook ? ` ${esc(d.hook)}` : ""}</p>
              <p style="margin:0;">It's already live, so you can click around on your phone too:</p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 28px 0;">
              <a href="${L.preview}" style="display:block;text-decoration:none;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;">
                <img src="${L.shot}" width="544" alt="Sample homepage for ${esc(d.business)} (click to open)" style="display:block;width:100%;max-width:544px;height:auto;border:0;">
              </a>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:22px 28px 6px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr><td align="center" style="background:${ACCENT};border-radius:10px;">
                  <a href="${L.preview}" style="display:inline-block;padding:15px 34px;font-size:17px;font-weight:800;color:#0f172a;text-decoration:none;">See your new website &rarr;</a>
                </td></tr>
              </table>
              <div style="font-size:13px;color:#777777;padding-top:10px;">Free to look at. No sign-up.</div>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 28px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${benefits.map(([icon, title, text], i) => `<tr>
                  <td style="padding:0 0 ${i === benefits.length - 1 ? 4 : 16}px;vertical-align:top;width:36px;font-size:22px;">${icon}</td>
                  <td style="padding:0 0 ${i === benefits.length - 1 ? 4 : 16}px;font-size:15px;line-height:1.5;color:#333333;"><strong style="color:#111111;">${title}</strong> ${text}</td>
                </tr>`).join("")}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;">
                <tr>
                  <td style="padding:20px 22px;font-size:15px;line-height:1.6;color:#333333;">
                    <div style="font-size:16px;font-weight:800;color:#111111;margin-bottom:8px;">Like it? It can be yours.</div>
                    This exact design can become ${esc(d.business)}'s website for <strong style="color:#111111;">${priceLine}</strong>, with ${included} included. Month to month, cancel anytime. Want changes first? Just reply and tell me what to change.
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
                      <tr><td align="center" style="background:#0f172a;border-radius:10px;">
                        <a href="${L.claim}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Make it my website &rarr;</a>
                      </td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e5e5;border-radius:12px;">
                <tr>
                  <td width="150" style="padding:16px 0 16px 16px;vertical-align:middle;">
                    <a href="${L.cards}"><img src="${siteUrl}/img/product-business-cards.jpg" width="134" alt="Metal business cards" style="display:block;width:134px;height:auto;border:0;border-radius:8px;"></a>
                  </td>
                  <td style="padding:16px 18px;vertical-align:middle;font-size:14px;line-height:1.55;color:#333333;">
                    <div style="font-size:15px;font-weight:800;color:#111111;margin-bottom:4px;">Also: metal business cards</div>
                    Laser-engraved steel cards people actually keep. Design yours with AI in a minute, from ${money(cardFrom)} a card.
                    <div style="margin-top:8px;"><a href="${L.cards}" style="color:#b45309;font-weight:700;text-decoration:none;">Design a card &rarr;</a></div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 28px 28px;font-size:15px;line-height:1.6;color:#333333;">
              <p style="margin:0 0 14px;">Questions? Just reply to this email${s.phone ? ` or call or text me at <a href="tel:${esc(s.phone.replace(/[^\d+]/g, ""))}" style="color:#b45309;font-weight:700;text-decoration:none;">${esc(s.phone)}</a>` : ""}.</p>
              <p style="margin:0;">Thanks,<br><strong>${esc(s.senderName)}</strong><br>EDZ Solutions &middot; <a href="${siteUrl}/web-design?utm_source=outreach&amp;utm_medium=email" style="color:#b45309;text-decoration:none;">edzsolutions.com</a></p>
            </td>
          </tr>

          <tr>
            <td style="background:#f7f7f7;padding:18px 28px;font-size:12px;line-height:1.6;color:#888888;">
              EDZ Solutions Corporation &middot; ${esc(s.address)}<br>
              You're getting this because ${esc(d.business)}'s contact email is listed on ${esc(foundOn)}. <a href="${L.unsub}" style="color:#888888;">Unsubscribe</a> and we won't email you again.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    hi,
    "",
    `${intro}${d.hook ? ` ${d.hook}` : ""}`,
    "",
    `It's already live, so you can click around on your phone too:`,
    L.preview,
    "",
    `Like it? This exact design can become ${d.business}'s website for ${priceLine}, with ${included} included. Month to month, cancel anytime. Want changes first? Just reply and tell me what to change.`,
    `Make it my website: ${L.claim}`,
    "",
    `Also: laser-engraved metal business cards, designed with AI in a minute, from ${money(cardFrom)} a card: ${L.cards}`,
    "",
    `Questions? Just reply to this email${s.phone ? ` or call or text me at ${s.phone}` : ""}.`,
    "",
    "Thanks,",
    s.senderName,
    "EDZ Solutions · edzsolutions.com",
    "",
    "--",
    `EDZ Solutions Corporation · ${s.address}`,
    `You're getting this because ${d.business}'s contact email is listed on ${foundOn}. Unsubscribe: ${L.unsub}`,
  ].join("\n");

  return { subject, html, text, unsub: L.unsub };
}

// The follow-up: short and personal, a reply in the same thread, with the screenshot again.
function buildFollowup(p, siteUrl) {
  const s = settings();
  const d = p.data || {};
  const L = links(p, siteUrl);
  const launch = plans.planById("launch");
  const noSite = !p.domain;
  const hi = firstName(d.contactName) ? `Hi ${firstName(d.contactName)},` : "Hi there,";
  const what = noSite ? "website I built" : "new homepage I made";
  const subject = `Re: ${noSite ? `I built a website for ${d.business}` : `I made a new homepage for ${d.business}`}`;
  const trade = d.industry ? String(d.industry).toLowerCase() : "businesses like yours";
  const who = d.city ? `people searching for ${trade} in ${d.city}` : `people searching for ${trade}`;
  const foundOn = noSite ? d.emailSource || "your public business listing" : p.domain;
  const lines = [
    `Just following up to see if you were interested in the ${what} for ${d.business}. Here it is again:`,
    `If you like it, we can get started on your site right away and have it live in about 3 days, so ${who} can find you, see what you offer and call you with one tap. It's ${money(launch.setupCents)} to set up and ${money(launch.monthlyCents)}/month, and you can cancel anytime.`,
    `Want something changed first? Just reply and tell me what you'd like different.`,
  ];
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#222222;">
      <tr><td>
        <p style="margin:0 0 14px;">${esc(hi)}</p>
        <p style="margin:0 0 14px;">${esc(lines[0])}</p>
        <p style="margin:0 0 6px;"><a href="${L.preview}" style="color:#b45309;font-weight:700;">See ${esc(d.business)}'s ${noSite ? "website" : "new homepage"} &rarr;</a></p>
        <a href="${L.preview}" style="display:block;max-width:360px;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden;margin:10px 0 18px;"><img src="${L.shot}" width="360" alt="${esc(d.business)} sample homepage" style="display:block;width:100%;height:auto;border:0;"></a>
        <p style="margin:0 0 14px;">${esc(lines[1])}</p>
        <p style="margin:0 0 18px;"><a href="${L.claim}" style="display:inline-block;background:#0f172a;color:#ffffff;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:9px;">Get started &rarr;</a></p>
        <p style="margin:0 0 14px;">${esc(lines[2])}</p>
        <p style="margin:0 0 24px;">Thanks,<br>${esc(s.senderName)}<br>EDZ Solutions${s.phone ? ` &middot; ${esc(s.phone)}` : ""}</p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:#888888;">EDZ Solutions Corporation &middot; ${esc(s.address)}<br>You're getting this because ${esc(d.business)}'s contact email is listed on ${esc(foundOn)}. <a href="${L.unsub}" style="color:#888888;">Unsubscribe</a> and we won't email you again.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const text = [hi, "", lines[0], L.preview, "", lines[1], `Get started: ${L.claim}`, "", lines[2], "", "Thanks,", s.senderName, "EDZ Solutions", "", "--", `EDZ Solutions Corporation · ${s.address}`, `You're getting this because ${d.business}'s contact email is listed on ${foundOn}. Unsubscribe: ${L.unsub}`].join("\n");
  return { subject, html, text, unsub: L.unsub };
}

async function sendEmail(p, siteUrl, m, { followup = false } = {}) {
  const { subject, html, text, unsub } = followup ? buildFollowup(p, siteUrl) : buildEmail(p, siteUrl);
  return getTransport(m).sendMail({
    from: m.from,
    to: p.email,
    subject,
    html,
    text,
    // A follow-up threads under the first email when we know its Message-ID.
    ...(followup && p.message_id ? { inReplyTo: p.message_id, references: [p.message_id] } : {}),
    // One-click unsubscribe (Gmail and Yahoo show an Unsubscribe link from this).
    headers: {
      // Link only: unsubscribing happens on the /u/ page, not by email.
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

// Sends per mailbox in the last 24 h, with each mailbox's warm-up limit.
async function mailboxStats(pool) {
  // First emails and follow-ups both count toward a mailbox's daily warm-up limit.
  const { rows } = await pool.query(
    `SELECT user_, sum(n)::int AS n FROM (
       SELECT lower(sent_from) AS user_, count(*) AS n FROM prospects WHERE sent_at > now() - interval '24 hours' GROUP BY 1
       UNION ALL
       SELECT lower(sent_from), count(*) FROM prospects WHERE followup_at > now() - interval '24 hours' GROUP BY 1
     ) t GROUP BY user_`
  ).then((r) => ({ rows: r.rows.map((x) => ({ user: x.user_, n: x.n })) }));
  const sent = Object.fromEntries(rows.map((r) => [r.user, r.n]));
  return mailboxes().map((m) => ({ user: m.user, sent24: sent[m.user] || 0, limit: warmupLimit(m) }));
}

// Sends ONE email to the oldest ready prospect from the least-used mailbox with room left.
// Returns { sent }, { bounced } or { done, reason }.
async function sendNext(pool, siteUrl, { only } = {}) {
  const why = notReady();
  if (why) return { done: true, reason: why };
  const { dailyLimit } = settings();
  const sent24 = (await pool.query("SELECT count(*)::int AS n FROM prospects WHERE sent_at > now() - interval '24 hours'")).rows[0].n;
  if (sent24 >= dailyLimit) return { done: true, reason: `Daily limit reached (${sent24}/${dailyLimit} in the last 24 hours).` };
  const stats = (await mailboxStats(pool)).filter((s) => s.sent24 < s.limit && (!only || s.user === only)).sort((a, b) => a.sent24 / a.limit - b.sent24 / b.limit);
  if (!stats.length) return { done: true, reason: "Every mailbox has reached its warm-up limit for the last 24 hours." };
  const m = mailboxes().find((x) => x.user === stats[0].user);

  const { rows } = await pool.query(
    `UPDATE prospects SET status='sending' WHERE id = (
       SELECT id FROM prospects WHERE status='ready' AND email IS NOT NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`
  );
  const p = rows[0];
  if (!p) return { done: true, reason: "No prospects are ready to email." };
  try {
    const info = await sendEmail(p, siteUrl, m);
    await pool.query("UPDATE prospects SET status='sent', sent_at=now(), sent_from=$2, message_id=$3 WHERE id=$1", [p.id, m.user, info.messageId || null]);
    return { sent: { business: p.data.business, email: p.email, from: m.user, preview: `${siteUrl}/p/${p.slug}` }, sentLast24h: sent24 + 1, dailyLimit };
  } catch (err) {
    // 5xx about the recipient (no such mailbox, rejected) → never retry that address.
    const bounced = err.responseCode >= 550 && /recipient|mailbox|user|address|rejected/i.test(String(err.response || err.message));
    await pool.query("UPDATE prospects SET status=$2, notes=$3 WHERE id=$1", [p.id, bounced ? "bounced" : "ready", String(err.response || err.message).slice(0, 300)]);
    console.error(`outreach send from ${m.user} failed:`, err.message);
    if (bounced) return { bounced: { business: p.data.business, email: p.email } };
    return { error: `Sending from ${m.user} failed: ${err.message}` };
  }
}

// Sends the follow-up for one prospect now, from the mailbox that sent the first email
// (so it lands in the same thread). Only for businesses still marked sent, once each.
async function sendFollowup(pool, siteUrl, id) {
  const why = notReady();
  if (why) return { error: why };
  const { rows } = await pool.query("SELECT * FROM prospects WHERE id=$1", [id]);
  const p = rows[0];
  if (!p || !p.email) return { error: "No such prospect." };
  if (p.status !== "sent") return { error: "Follow-ups only go to businesses that were emailed and haven't replied, bounced or unsubscribed." };
  if (p.followup_at) return { error: "A follow-up was already sent." };
  const m = mailboxes().find((x) => x.user === (p.sent_from || "").toLowerCase()) || mailboxes()[0];
  const stat = (await mailboxStats(pool)).find((x) => x.user === m.user);
  if (stat && stat.sent24 >= stat.limit) return { error: `${m.user} has reached today's warm-up limit (${stat.limit}). Try again tomorrow.` };
  try {
    await sendEmail(p, siteUrl, m, { followup: true });
  } catch (err) {
    return { error: `Sending failed: ${err.message}` };
  }
  // sent_from stays the original mailbox; followup_at records the follow-up for limits and the admin.
  await pool.query("UPDATE prospects SET followup_at=now() WHERE id=$1", [p.id]);
  return { ok: true, business: p.data.business, email: p.email, from: m.user };
}

// Called every few minutes by the web server: on weekdays inside the window, each
// mailbox with room left sends one email. Ten-minute ticks space each mailbox's sends out.
async function tick(pool, siteUrl) {
  if (notReady() || !inWindow()) return [];
  // Only one server process sends at a time.
  const lock = await pool.query("SELECT pg_try_advisory_lock(424242) AS ok");
  if (!lock.rows[0].ok) return [];
  const results = [];
  try {
    for (const m of mailboxes()) {
      const out = await sendNext(pool, siteUrl, { only: m.user });
      results.push(out);
      if (out.done && /limit reached|No prospects|paused|isn't set up/.test(out.reason) && !/warm-up/.test(out.reason)) break;
    }
  } finally {
    await pool.query("SELECT pg_advisory_unlock(424242)");
  }
  for (const r of results) {
    if (r.sent) console.log(`outreach: sent ${r.sent.email} from ${r.sent.from}`);
    if (r.bounced) console.log(`outreach: bounced ${r.bounced.email}`);
    if (r.error) console.log(`outreach: ${r.error}`);
  }
  return results;
}

module.exports = { buildEmail, buildFollowup, sendFollowup, sendEmail, sendNext, tick, mailboxStats, mailboxes, warmupLimit, inWindow, settings, notReady };
