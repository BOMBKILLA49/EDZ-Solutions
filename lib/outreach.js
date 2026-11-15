// Cold outreach email: one email per prospect showing a screenshot of the sample
// homepage we built for them (/p/<slug>), plus a metal business card pitch.
// Sent from a separate outreach mailbox (OUTREACH_SMTP_*) so spam complaints can't
// hurt edzsolutions.com, where order alerts and customer email live.

const nodemailer = require("nodemailer");
const plans = require("../config/plans");
const catalog = require("../config/catalog");
const { esc } = require("./preview");

const env = (k, d = "") => (process.env[k] || d).trim();

const settings = () => ({
  from: env("OUTREACH_FROM"), // "Ty at EDZ Solutions <ty@outreach-domain.com>"
  senderName: env("OUTREACH_SENDER_NAME"),
  phone: env("OUTREACH_PHONE"),
  address: env("OUTREACH_ADDRESS"), // postal address, required by CAN-SPAM
  dailyLimit: Math.max(0, Number(env("OUTREACH_DAILY_LIMIT", "10")) || 0),
  paused: env("OUTREACH_PAUSED") === "1",
});

// Why sending is off, or null when it's ready.
function notReady() {
  const s = settings();
  if (s.paused) return "Outreach is paused (OUTREACH_PAUSED=1).";
  const missing = ["OUTREACH_SMTP_HOST", "OUTREACH_SMTP_USER", "OUTREACH_SMTP_PASS", "OUTREACH_FROM", "OUTREACH_SENDER_NAME", "OUTREACH_ADDRESS"].filter((k) => !env(k));
  return missing.length ? `Outreach email isn't set up. Missing: ${missing.join(", ")}` : null;
}

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env("OUTREACH_SMTP_HOST"),
      port: Number(env("OUTREACH_SMTP_PORT", "465")),
      secure: Number(env("OUTREACH_SMTP_PORT", "465")) === 465,
      auth: { user: env("OUTREACH_SMTP_USER"), pass: env("OUTREACH_SMTP_PASS") },
    });
  }
  return transport;
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
  const site = p.domain || "your website";
  const where = [d.industry ? String(d.industry).toLowerCase() : "local businesses", d.city ? `in ${d.city}` : ""].filter(Boolean).join(" ");
  const subject = `I made a new homepage for ${d.business}`;
  const intro = `I came across ${site} while looking at ${where}, and I put together a modern homepage for ${d.business} using the info already on your site.`;
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
              <h1 style="margin:10px 0 0;font-size:28px;line-height:1.2;font-weight:800;color:#111111;">Here's a new homepage for ${esc(d.business)}.</h1>
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
                    This exact design can become ${esc(d.business)}'s website for <strong style="color:#111111;">${priceLine}</strong>, with hosting, security and your domain hookup included. Month to month, cancel anytime. Want changes first? Just reply and tell me what to change.
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
              This is a one-time email. You're getting it because ${esc(d.business)}'s contact email is listed on ${esc(site)}. <a href="${L.unsub}" style="color:#888888;">Unsubscribe</a> and we won't email you again.
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
    `Like it? This exact design can become ${d.business}'s website for ${priceLine}, with hosting, security and your domain hookup included. Month to month, cancel anytime. Want changes first? Just reply and tell me what to change.`,
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
    `This is a one-time email. You're getting it because ${d.business}'s contact email is listed on ${site}. Unsubscribe: ${L.unsub}`,
  ].join("\n");

  return { subject, html, text, unsub: L.unsub };
}

async function sendEmail(p, siteUrl) {
  const s = settings();
  const { subject, html, text, unsub } = buildEmail(p, siteUrl);
  const replyTo = /<([^>]+)>/.exec(s.from)?.[1] || s.from;
  return getTransport().sendMail({
    from: s.from,
    to: p.email,
    subject,
    html,
    text,
    // One-click unsubscribe (Gmail and Yahoo show an Unsubscribe link from this).
    headers: {
      "List-Unsubscribe": `<${unsub}>, <mailto:${replyTo}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

module.exports = { buildEmail, sendEmail, settings, notReady };
