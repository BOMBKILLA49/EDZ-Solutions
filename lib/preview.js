// Sample homepage for an outreach prospect, served at /p/<slug>. Everything on it comes
// from the prospect's own website (gathered by Grok Bot); nothing is made up, so the
// same page can become their real site if they sign up.

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || "")) ? String(u) : "");

function hexColor(v, fallback = "#1d4ed8") {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v || "").trim());
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

// Mix a hex color toward black (amount < 0) or white (amount > 0).
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const a = Math.abs(amount);
  const ch = (s) => Math.round(((n >> s) & 255) * (1 - a) + target * a);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

// Very dark brand colors keep white text; light ones (yellow, lime) get dark text.
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [16, 8, 0].map((s) => ((n >> s) & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#0f172a" : "#ffffff";
}

// First sentence, without stopping at "Inc.", "Co.", "St." and the like.
const ABBREV = /\b(?:inc|co|corp|ltd|llc|bros|st|ave|blvd|rd|dr|mr|mrs|ms|jr|sr|no|vs|est)\.$/i;
function firstSentence(text) {
  const t = String(text).trim();
  const re = /[.!?](?=\s+["'(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(t))) {
    const head = t.slice(0, m.index + 1);
    if (!ABBREV.test(head)) return head;
  }
  return t;
}

const telHref = (phone) => `tel:${String(phone || "").replace(/[^\d+]/g, "")}`;

function services(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => (typeof s === "string" ? { name: s } : s || {}))
    .filter((s) => s.name)
    .slice(0, 9);
}

const ICON = {
  check: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
};

// `claimUrl` is where the banner's button goes; `shot` hides the banner for the email screenshot.
// `siteUrl` makes the link-preview tags absolute, so Facebook Messenger, iMessage and texts show
// a card with a screenshot of their new homepage when the link is pasted.
function renderPreview(p, { claimUrl, shot = false, siteUrl = "", hasShot = false, year = new Date().getFullYear() } = {}) {
  const d = p.data || {};
  const color = hexColor(d.color);
  const onColor = textOn(color);
  const dark = shade(color, -0.55);
  const photos = (Array.isArray(d.photoUrls) ? d.photoUrls : []).map(safeUrl).filter(Boolean).slice(0, 6);
  const logo = safeUrl(d.logoUrl);
  const place = [d.city, d.state].filter(Boolean).join(", ");
  const svc = services(d.services);
  const headline = d.tagline || (d.industry && d.city ? `${d.industry} in ${d.city} you can count on` : d.business);
  const sub = d.about ? firstSentence(d.about) : place ? `Proudly serving ${place} and the surrounding area.` : "";
  const facts = [
    place && { icon: "pin", title: `Local to ${d.city || place}`, text: d.area || `Serving ${place} and nearby` },
    d.hours && { icon: "clock", title: "Hours", text: d.hours },
    d.phone && { icon: "phone", title: "Call or text", text: d.phone },
    !d.phone && d.email && { icon: "mail", title: "Email us", text: d.email },
  ].filter(Boolean);
  const heroBg = photos[0]
    ? `linear-gradient(100deg, rgba(10,14,25,.88) 0%, rgba(10,14,25,.62) 55%, rgba(10,14,25,.25) 100%), url('${esc(photos[0])}') center/cover`
    : `radial-gradient(1200px 500px at 85% -10%, ${shade(color, 0.25)}55, transparent 60%), linear-gradient(135deg, ${dark}, ${shade(color, -0.25)})`;
  const mapQuery = d.address ? encodeURIComponent(d.address) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.business)}${place ? ` | ${esc(place)}` : ""}</title>
<meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(d.business)}: ${d.website ? "your new homepage" : "your new website"}">
<meta property="og:description" content="${esc(`A free sample ${d.website ? "homepage" : "website"} made for ${d.business}${place ? ` in ${place}` : ""} by EDZ Solutions. Tap to see it.`)}">
${siteUrl ? `<meta property="og:url" content="${esc(`${siteUrl}/p/${p.slug}`)}">
<meta property="og:image" content="${esc(hasShot ? `${siteUrl}/p/${p.slug}/og.jpg` : `${siteUrl}/img/home-websites.jpg`)}">
${hasShot ? `<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">` : ""}
<meta name="twitter:card" content="summary_large_image">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>
  :root { --c: ${color}; --on: ${onColor}; --dark: ${dark}; --ink: #0f172a; --text: #334155; --muted: #64748b; --line: #e2e8f0; --soft: #f8fafc; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; font: 17px/1.65 Inter, system-ui, sans-serif; color: var(--text); background: #fff; }
  h1, h2, h3 { overflow-wrap: anywhere; font-family: "Plus Jakarta Sans", Inter, sans-serif; color: var(--ink); line-height: 1.15; margin: 0 0 .5em; letter-spacing: -.02em; }
  a { color: inherit; }
  img { max-width: 100%; display: block; }
  .wrap { max-width: 1160px; margin: 0 auto; padding: 0 24px; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 24px; border-radius: 12px; font-weight: 700; text-decoration: none; border: 2px solid transparent; transition: transform .15s; }
  .btn:hover { transform: translateY(-1px); }
  .btn-c { background: var(--c); color: var(--on); }
  .btn-w { background: #fff; color: var(--ink); }
  .btn-o { border-color: rgba(255,255,255,.55); color: #fff; }
  .edz { background: #0f172a; color: #e2e8f0; font-size: 15px; }
  .edz .wrap { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-top: 10px; padding-bottom: 10px; flex-wrap: wrap; }
  .edz b { color: #fbbf24; }
  .edz a { background: #f59e0b; color: #0f172a; padding: 8px 16px; border-radius: 10px; font-weight: 800; text-decoration: none; white-space: nowrap; }
  header { position: sticky; top: 0; z-index: 10; background: rgba(255,255,255,.96); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
  header .wrap { display: flex; align-items: center; justify-content: space-between; height: 76px; gap: 16px; }
  .brand { min-width: 0; display: flex; align-items: center; gap: 12px; font: 800 21px "Plus Jakarta Sans", sans-serif; color: var(--ink); text-decoration: none; }
  .brand img { max-height: 48px; width: auto; }
  nav { display: flex; align-items: center; gap: 28px; font-weight: 600; font-size: 15px; }
  nav a.link { text-decoration: none; color: var(--text); }
  nav .btn { padding: 11px 18px; }
  @media (max-width: 820px) { nav a.link { display: none; } }
  .hero { background: ${heroBg}; background-color: ${dark}; color: #fff; }
  .hero .wrap { padding-top: 110px; padding-bottom: 120px; }
  .eyebrow { display: inline-block; font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; background: rgba(255,255,255,.14); padding: 6px 12px; border-radius: 99px; margin-bottom: 20px; }
  .hero h1 { color: #fff; font-size: clamp(38px, 5.6vw, 64px); max-width: 780px; }
  .hero p { font-size: 20px; max-width: 620px; color: rgba(255,255,255,.88); margin: 0 0 32px; }
  .hero .ctas { display: flex; gap: 14px; flex-wrap: wrap; }
  .facts { background: var(--dark); color: #fff; }
  .facts .wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 20px; padding-top: 26px; padding-bottom: 26px; }
  .fact { display: flex; gap: 14px; align-items: flex-start; }
  .fact .ic { width: 44px; height: 44px; border-radius: 12px; background: var(--c); color: var(--on); display: grid; place-items: center; flex: none; }
  .fact b { display: block; font-size: 16px; }
  .fact span { color: rgba(255,255,255,.75); font-size: 15px; white-space: pre-line; }
  section { padding: 96px 0; }
  .kicker { color: var(--c); font-weight: 800; font-size: 14px; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 10px; }
  .soft { background: var(--soft); }
  .head { max-width: 660px; margin-bottom: 44px; }
  .head h2 { font-size: clamp(30px, 3.6vw, 42px); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 20px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: 28px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
  .card .ic { width: 46px; height: 46px; border-radius: 12px; background: color-mix(in srgb, var(--c) 14%, #fff); color: var(--c); display: grid; place-items: center; margin-bottom: 16px; }
  .card h3 { font-size: 20px; }
  .card p { margin: 0; color: var(--muted); font-size: 16px; }
  .about { display: grid; grid-template-columns: 1.1fr 1fr; gap: 56px; align-items: center; }
  @media (max-width: 860px) { .about { grid-template-columns: 1fr; } }
  .about img { border-radius: 20px; aspect-ratio: 4/3; object-fit: cover; width: 100%; box-shadow: 0 20px 40px rgba(15,23,42,.15); }
  .about p { white-space: pre-line; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 14px; }
  .gallery img { border-radius: 14px; aspect-ratio: 4/3; object-fit: cover; width: 100%; }
  .cta { background: linear-gradient(135deg, var(--c), ${shade(color, -0.3)}); color: var(--on); text-align: center; }
  .cta h2 { color: var(--on); font-size: clamp(30px, 4vw, 46px); }
  .cta p { font-size: 19px; opacity: .9; margin: 0 0 28px; }
  .cta .btn { background: var(--on); color: ${onColor === "#ffffff" ? "var(--c)" : "#fff"}; }
  .contact { display: grid; grid-template-columns: 1fr 1.2fr; gap: 40px; }
  @media (max-width: 860px) { .contact { grid-template-columns: 1fr; } }
  .rows { display: grid; gap: 18px; }
  .row { display: flex; gap: 14px; }
  .row .ic { color: var(--c); flex: none; padding-top: 2px; }
  .row b { display: block; color: var(--ink); }
  .row span, .row a { white-space: pre-line; text-decoration: none; }
  .map { border: 0; width: 100%; min-height: 340px; border-radius: 18px; background: var(--soft); }
  footer { background: #0b1120; color: #94a3b8; font-size: 15px; }
  footer .wrap { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-top: 28px; padding-bottom: 28px; }
  footer a { color: #cbd5e1; }
  @media (max-width: 560px) {
    .wrap { padding: 0 18px; }
    header .wrap { height: 64px; }
    .brand { font-size: 17px; }
    .brand img { max-height: 38px; }
    nav .btn { padding: 10px 12px; }
    nav .btn .num { display: none; }
    .hero .wrap { padding-top: 64px; padding-bottom: 72px; }
    .hero p { font-size: 18px; }
    .hero .ctas .btn { width: 100%; justify-content: center; }
    section { padding: 64px 0; }
    .edz .wrap { font-size: 14px; }
  }
</style>
</head>
<body>
${shot ? "" : `<div class="edz"><div class="wrap"><span>This is a <b>free sample homepage</b> EDZ Solutions made for ${esc(d.business)}. Like it? It can be live in about 3 days.</span><a href="${esc(claimUrl)}">Make it my website &rarr;</a></div></div>`}
<header><div class="wrap">
  <a class="brand" href="#top">${logo ? `<img src="${esc(logo)}" alt="${esc(d.business)}" onerror="this.remove()">` : ""}<span>${esc(d.business)}</span></a>
  <nav>
    ${svc.length ? '<a class="link" href="#services">Services</a>' : ""}
    ${d.about ? '<a class="link" href="#about">About</a>' : ""}
    <a class="link" href="#contact">Contact</a>
    ${d.phone ? `<a class="btn btn-c" href="${telHref(d.phone)}">${ICON.phone} <span class="num">${esc(d.phone)}</span></a>` : d.email ? `<a class="btn btn-c" href="mailto:${esc(d.email)}">Email us</a>` : ""}
  </nav>
</div></header>

<div class="hero" id="top"><div class="wrap">
  ${d.industry || place ? `<div class="eyebrow">${esc([d.industry, place].filter(Boolean).join(" · "))}</div>` : ""}
  <h1>${esc(headline)}</h1>
  ${sub ? `<p>${esc(sub)}</p>` : ""}
  <div class="ctas">
    ${d.phone ? `<a class="btn btn-c" href="${telHref(d.phone)}">${ICON.phone} Call ${esc(d.phone)}</a>` : ""}
    ${d.email ? `<a class="btn btn-o" href="mailto:${esc(d.email)}">Get a free quote</a>` : ""}
  </div>
</div></div>

${facts.length ? `<div class="facts"><div class="wrap">${facts.map((f) => `<div class="fact"><div class="ic">${ICON[f.icon]}</div><div><b>${esc(f.title)}</b><span>${esc(f.text)}</span></div></div>`).join("")}</div></div>` : ""}

${svc.length ? `<section class="soft" id="services"><div class="wrap">
  <div class="head"><div class="kicker">What we do</div><h2>${esc(d.servicesTitle || `Services${d.city ? ` in ${d.city}` : ""}`)}</h2></div>
  <div class="grid">${svc.map((s) => `<div class="card"><div class="ic">${ICON.check}</div><h3>${esc(s.name)}</h3>${s.desc ? `<p>${esc(s.desc)}</p>` : ""}</div>`).join("")}</div>
</div></section>` : ""}

${d.about ? `<section id="about"><div class="wrap about">
  <div><div class="kicker">About us</div><h2 style="font-size:clamp(30px,3.6vw,42px)">${esc(d.aboutTitle || `About ${d.business}`)}</h2><p>${esc(d.about)}</p>
  ${d.phone ? `<a class="btn btn-c" href="${telHref(d.phone)}" style="margin-top:12px">${ICON.phone} Talk to us</a>` : ""}</div>
  ${photos[1] ? `<img src="${esc(photos[1])}" alt="" onerror="this.remove()">` : ""}
</div></section>` : ""}

${photos.length > 2 ? `<section class="soft" style="padding-top:72px;padding-bottom:72px"><div class="wrap">
  <div class="head" style="margin-bottom:28px"><div class="kicker">Our work</div><h2>Take a look</h2></div>
  <div class="gallery">${photos.slice(2).map((u) => `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()">`).join("")}</div>
</div></section>` : ""}

<section class="cta"><div class="wrap">
  <h2>${esc(d.ctaTitle || "Ready when you are")}</h2>
  <p>${esc(d.phone ? `Call ${d.phone}${d.email ? " or send us an email" : ""} and we'll take care of you.` : "Send us a message and we'll get right back to you.")}</p>
  ${d.phone ? `<a class="btn" href="${telHref(d.phone)}">${ICON.phone} Call now</a>` : d.email ? `<a class="btn" href="mailto:${esc(d.email)}">Email us</a>` : ""}
</div></section>

<section id="contact"><div class="wrap contact">
  <div>
    <div class="kicker">Contact</div><h2 style="font-size:clamp(30px,3.6vw,42px)">Get in touch</h2>
    <div class="rows">
      ${d.phone ? `<div class="row"><div class="ic">${ICON.phone}</div><div><b>Phone</b><a href="${telHref(d.phone)}">${esc(d.phone)}</a></div></div>` : ""}
      ${d.email ? `<div class="row"><div class="ic">${ICON.mail}</div><div><b>Email</b><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></div></div>` : ""}
      ${d.address ? `<div class="row"><div class="ic">${ICON.pin}</div><div><b>Address</b><span>${esc(d.address)}</span></div></div>` : ""}
      ${d.hours ? `<div class="row"><div class="ic">${ICON.clock}</div><div><b>Hours</b><span>${esc(d.hours)}</span></div></div>` : ""}
    </div>
  </div>
  ${mapQuery ? `<iframe class="map" loading="lazy" src="https://maps.google.com/maps?q=${mapQuery}&amp;z=13&amp;output=embed" title="Map"></iframe>` : ""}
</div></section>

<footer><div class="wrap"><span>&copy; ${year} ${esc(d.business)}${place ? ` &middot; ${esc(place)}` : ""}</span><span>Sample design by <a href="https://www.edzsolutions.com/web-design">EDZ Solutions</a></span></div></footer>
</body>
</html>`;
}

module.exports = { renderPreview, esc, safeUrl, hexColor };
