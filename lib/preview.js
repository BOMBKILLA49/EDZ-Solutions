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

// What we couldn't find for a business, in plain words, for the sample page and messages.
// `skip` leaves out what the reader obviously has (e.g. "email" in an email to them).
function missingInfo(d, skip = []) {
  return [
    !d.logoUrl && "logo",
    !d.phone && "phone number",
    !d.email && "email",
    !d.address && "address",
    !d.hours && "hours",
    !(Array.isArray(d.photoUrls) && d.photoUrls.length) && "photos",
  ].filter((x) => x && !skip.includes(x));
}

// ["phone number", "address", "logo"] → "phone number, address or logo"
const listOr = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`);
const listAnd = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

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
  chat: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
};

// Heading font styles they can pick (outreach samples use "modern").
const FONTS = {
  modern: { family: "Plus Jakarta Sans", css: "Plus+Jakarta+Sans:wght@700;800", spacing: "-.02em" },
  classic: { family: "Playfair Display", css: "Playfair+Display:wght@700;800", spacing: "0" },
  bold: { family: "Oswald", css: "Oswald:wght@600;700", spacing: ".01em" },
  friendly: { family: "Nunito", css: "Nunito:wght@800;900", spacing: "0" },
};
const STANDARD_COLOR = "#1d4ed8"; // Launch plan's standard look

// The pages each website plan includes, in menu order (matches config/plans.js): Website is one
// page; Website + Growth has up to 8 (these 7 in the preview).
function planPages(plan) {
  const base = [{ id: "home", label: "Home" }, { id: "services", label: "Services" }, { id: "about", label: "About" }, { id: "contact", label: "Contact" }];
  if (plan === "growth") {
    return [base[0], base[1], { id: "areas", label: "Service areas" }, { id: "reviews", label: "Reviews" }, { id: "gallery", label: "Our work" }, base[2], base[3]];
  }
  return [base[0]];
}

// `claimUrl` is where the banner's button goes; `shot` hides the banner for the email screenshot.
// `siteUrl` makes the link-preview tags absolute, so Facebook Messenger, iMessage and texts show
// a card with a screenshot of their new homepage when the link is pasted.
// `heroImage` is the trade's AI stock photo, used when we have none of their own photos.
// `draft` is the live preview on the /start form: no EDZ banner, and the "missing" notes point
// at the form instead of a link. A draft logo may be the visitor's uploaded file (data: URL).
// `plan` and `page` (for the /start preview) show what each website plan includes: Launch is
// one page; Website + Growth has more pages (see planPages).
// `google` is their live Google content (lib/googlePlaces.js): photos (used when they have none of
// their own), rating, Google's description and reviews, each credited and linked to Google Maps.
function renderPreview(p, { claimUrl, shot = false, draft = false, siteUrl = "", hasShot = false, heroImage = "", google = null, plan = "", page = "home", feature = "", year = new Date().getFullYear() } = {}) {
  const d = p.data || {};
  // Every plan gets their own colors and font (outreach samples use our standard blue).
  const color = d.color ? hexColor(d.color) : STANDARD_COLOR;
  const font = FONTS[FONTS[d.font] ? d.font : "modern"];
  const onColor = textOn(color);
  const dark = shade(color, -0.55);
  const own = (Array.isArray(d.photoUrls) ? d.photoUrls : []).map(safeUrl).filter(Boolean).slice(0, 6);
  const gPhotos = own.length ? [] : (google?.photos || []).filter((x) => safeUrl(x.url));
  let photos = own.length ? own : gPhotos.map((x) => x.url);
  // Google requires the photographer's name and a link to Google Maps on each of their photos.
  const credit = (i) => (gPhotos[i] ? `<a class="gcredit" href="${esc(safeUrl(gPhotos[i].mapsUri) || safeUrl(google.mapsUri) || "#")}" target="_blank" rel="noopener">Photo${gPhotos[i].author ? `: ${esc(gPhotos[i].author)}` : ""} · Google Maps</a>` : "");
  const gSummary = !d.about && google?.summary ? google.summary : "";
  const about = d.about || gSummary;
  const reviews = (google?.reviews || []).slice(0, 3);
  // What each of their own photos shows (from the /start form): alt text and a caption.
  let labels = own.length && Array.isArray(d.photoLabels) ? d.photoLabels : [];
  // Separate header banner (Edit info): heroUrl, or the trade's AI photo when it's empty. Their
  // own photos then all go to About and "Take a look" instead of the first becoming the header.
  const heroOwn = safeUrl(d.heroUrl);
  if ((d.heroSeparate || heroOwn) && own.length) {
    photos = ["", ...own];
    labels = ["", ...labels];
  }
  const alt = (i) => esc(labels[i] || "");
  const caption = (i) => (labels[i] ? `<span class="cap">${esc(labels[i])}</span>` : "");
  const menu = (Array.isArray(d.menu) ? d.menu : []).filter((m) => m?.items?.length);
  const badges = (Array.isArray(d.badges) ? d.badges : []).slice(0, 6);
  const ctaLink = d.ctaLink && safeUrl(d.ctaLink.url) ? d.ctaLink : null;
  const logo = (draft && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(d.logoData || "") ? d.logoData : "") || safeUrl(d.logoUrl);
  const place = [d.city, d.state].filter(Boolean).join(", ");
  const svc = services(d.services);
  const headline = d.tagline || (d.industry && d.city ? `${d.industry} in ${d.city} you can count on` : d.business);
  const sub = about ? firstSentence(about) : place ? `Proudly serving ${place} and the surrounding area.` : "";
  const facts = [
    place && { icon: "pin", title: `Local to ${d.city || place}`, text: d.area || `Serving ${place} and nearby` },
    d.hours && { icon: "clock", title: "Hours", text: d.hours },
    d.phone && { icon: "phone", title: "Call or text", text: d.phone },
    !d.phone && d.email && { icon: "mail", title: "Email us", text: d.email },
    ...(Array.isArray(d.typeFacts) ? d.typeFacts : []).slice(0, 3).map((f) => ({
      icon: "check",
      title: f.key === "years" && /^\d{1,3}$/.test(f.value) ? `${f.value} years in business` : f.key === "license" ? "Licensed" : f.label,
      text: f.key === "years" && /^\d{1,3}$/.test(f.value) ? "Local and experienced" : f.key === "license" ? `License #${f.value.replace(/^#/, "")}` : f.value,
    })),
    google?.rating && google.count && { icon: "star", title: `${google.rating.toFixed(1)} ★ on Google`, text: `${google.count} review${google.count === 1 ? "" : "s"}`, href: google.mapsUri },
  ].filter(Boolean);
  const heroPhoto = heroOwn || photos[0] || heroImage;
  const missing = missingInfo({ ...d, logoUrl: logo, photoUrls: photos });
  const noContact = !d.phone && !d.email && !d.address;
  const heroBg = heroPhoto
    ? `linear-gradient(100deg, rgba(10,14,25,.88) 0%, rgba(10,14,25,.62) 55%, rgba(10,14,25,.25) 100%), url('${esc(heroPhoto)}') center/cover`
    : `radial-gradient(1200px 500px at 85% -10%, ${shade(color, 0.25)}55, transparent 60%), linear-gradient(135deg, ${dark}, ${shade(color, -0.25)})`;
  const mapQuery = d.address ? encodeURIComponent(d.address) : "";

  // ---------- sections (shared by the homepage and the plan's other pages) ----------
  const multi = Boolean(plan && plan !== "launch");
  const pages = planPages(plan);
  const navLink = (id, label, anchor) => (multi
    ? `<a class="link${id === page ? " on" : ""}" href="#page-${id}">${label}</a>`
    : `<a class="link" href="#${anchor || id}">${label}</a>`);
  const header = `<header><div class="wrap">
  <a class="brand" href="#top">${logo ? `<img src="${esc(logo)}" alt="${esc(d.business)}" onerror="this.remove()">` : ""}<span>${esc(d.business)}</span></a>
  <nav>
    ${multi
      ? pages.filter((x) => x.id !== "home" && x.inNav !== false).slice(0, 6).map((x) => navLink(x.id, x.label)).join("")
      : `${svc.length ? navLink("services", "Services") : ""}${menu.length ? navLink("menu", "Menu") : ""}${about ? navLink("about", "About") : ""}${reviews.length ? navLink("reviews", "Reviews") : ""}${navLink("contact", "Contact")}`}
    ${plan === "solution" ? `<a class="btn btn-line" href="#page-login">Customer login</a>` : ""}
    ${d.phone ? `<a class="btn btn-c" href="${telHref(d.phone)}">${ICON.phone} <span class="num">${esc(d.phone)}</span></a>` : d.email ? `<a class="btn btn-c" href="mailto:${esc(d.email)}">Email us</a>` : ""}
  </nav>
</div></header>`;

  const heroHtml = `<div class="hero" id="top"><div class="wrap">
  ${d.industry || place ? `<div class="eyebrow">${esc([d.industry, place].filter(Boolean).join(" · "))}</div>` : ""}
  <h1>${esc(headline)}</h1>
  ${sub ? `<p>${esc(sub)}</p>` : ""}
  <div class="ctas">
    ${d.phone ? `<a class="btn btn-c" href="${telHref(d.phone)}">${ICON.phone} Call ${esc(d.phone)}</a>` : ""}
    ${ctaLink ? `<a class="btn btn-o" href="${esc(ctaLink.url)}" target="_blank" rel="noopener">${esc(ctaLink.label)}</a>` : menu.length ? `<a class="btn btn-o" href="#menu">See our menu</a>` : ""}
    ${ctaLink || menu.length ? "" : d.email ? `<a class="btn btn-o" href="mailto:${esc(d.email)}">Get a free quote</a>` : ""}
  </div>
  ${badges.length ? `<div class="badges">${badges.map((x) => `<span>${ICON.check} ${esc(x)}</span>`).join("")}</div>` : ""}
</div>${credit(0)}</div>`;
  // Inside pages get a smaller title band with the same photo.
  const pageHead = (kicker, title, text) => `<div class="hero pagehead" id="top"><div class="wrap">
  <div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ""}
</div></div>`;

  const factsHtml = facts.length ? `<div class="facts"><div class="wrap">${facts.map((f) => `<div class="fact"><div class="ic">${ICON[f.icon]}</div><div><b>${esc(f.title)}</b>${f.href && safeUrl(f.href) ? `<a href="${esc(f.href)}" target="_blank" rel="noopener">${esc(f.text)} · Google Maps</a>` : `<span>${esc(f.text)}</span>`}</div></div>`).join("")}</div></div>` : "";

  const servicesHtml = (title) => (svc.length ? `<section class="soft" id="services"><div class="wrap">
  <div class="head"><div class="kicker">What we do</div><h2>${esc(title || d.servicesTitle || `Services${d.city ? ` in ${d.city}` : ""}`)}</h2></div>
  <div class="grid">${svc.map((s) => `<div class="card"><div class="ic">${ICON.check}</div><h3>${esc(s.name)}</h3>${s.desc ? `<p>${esc(s.desc)}</p>` : multi && page === "services" ? `<p class="ph">A few lines about this service go here.</p>` : ""}</div>`).join("")}</div>
</div></section>` : menu.length ? "" : placeholder("Your services go here", draft ? "List them on the form to see them on your site." : "Tell us what you offer and we'll list each one."));

  const menuHtml = menu.length ? `<section id="menu"><div class="wrap">
  <div class="head"><div class="kicker">Menu</div><h2>Our menu</h2></div>
  <div class="menu">${menu.map((m) => `<div class="menu-sec"><h3>${esc(m.name)}</h3>${m.items.map((i) => `<div class="menu-item"><div class="mi-top"><b>${esc(i.name)}</b><span class="dots"></span>${i.price ? `<span class="mi-price">${esc(i.price)}</span>` : ""}</div>${i.desc ? `<p>${esc(i.desc)}</p>` : ""}</div>`).join("")}</div>`).join("")}</div>
</div></section>` : "";

  const aboutHtml = (force) => (about || force ? `<section id="about"><div class="wrap about">
  <div><div class="kicker">About us</div><h2 style="font-size:clamp(30px,3.6vw,42px)">${esc(d.aboutTitle || `About ${d.business}`)}</h2>${about ? `<p>${esc(about)}</p>${gSummary ? `<p class="gsrc">Description from <a href="${esc(safeUrl(google.mapsUri) || "#")}" target="_blank" rel="noopener">Google Maps</a></p>` : ""}` : `<p class="ph">Your story goes here: who you are, how long you've been doing this, and what makes you different.</p>`}
  ${d.phone ? `<a class="btn btn-c" href="${telHref(d.phone)}" style="margin-top:12px">${ICON.phone} Talk to us</a>` : ""}</div>
  ${photos[1] ? `<div class="pic"><img src="${esc(photos[1])}" alt="${alt(1)}" onerror="this.parentNode.remove()">${credit(1)}${caption(1)}</div>` : ""}
</div></section>` : "");

  // The 2nd photo goes beside the About text; with no About section, the gallery starts there.
  const gStart = about ? 2 : 1;
  const galleryHtml = (force) => (photos.length > gStart || force ? `<section class="soft" style="padding-top:72px;padding-bottom:72px"><div class="wrap">
  <div class="head" style="margin-bottom:28px"><div class="kicker">Our work</div><h2>Take a look</h2></div>
  <div class="gallery">${photos.length > gStart ? photos.slice(gStart).map((u, i) => `<div class="pic"><img src="${esc(u)}" alt="${alt(i + gStart)}" loading="lazy" onerror="this.parentNode.remove()">${credit(i + gStart)}${caption(i + gStart)}</div>`).join("") : [1, 2, 3, 4, 5, 6].map(() => `<div class="ph-tile">Your project photo</div>`).join("")}</div>
</div></section>` : "");

  const ctaHtml = `<section class="cta"><div class="wrap">
  <h2>${esc(d.ctaTitle || "Ready when you are")}</h2>
  <p>${esc(d.phone ? `Call ${d.phone}${d.email ? " or send us an email" : ""} and we'll take care of you.` : "Send us a message and we'll get right back to you.")}</p>
  ${d.phone ? `<a class="btn" href="${telHref(d.phone)}">${ICON.phone} Call now</a>` : d.email ? `<a class="btn" href="mailto:${esc(d.email)}">Email us</a>` : `<a class="btn" href="${esc(claimUrl)}">${ICON.phone} Add your phone number</a>`}
</div></section>`;

  const mapHtml = mapQuery ? `<iframe class="map" src="https://maps.google.com/maps?q=${mapQuery}&amp;z=13&amp;output=embed" title="Map of ${esc(d.address)}"></iframe>` : "";
  const contactHtml = (withForm) => `<section id="contact"><div class="wrap contact">
  <div>
    <div class="kicker">Contact</div><h2 style="font-size:clamp(30px,3.6vw,42px)">Get in touch</h2>
    <div class="rows">
      ${d.phone ? `<div class="row"><div class="ic">${ICON.phone}</div><div><b>Phone</b><a href="${telHref(d.phone)}">${esc(d.phone)}</a></div></div>` : ""}
      ${d.email ? `<div class="row"><div class="ic">${ICON.mail}</div><div><b>Email</b><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></div></div>` : ""}
      ${d.address ? `<div class="row"><div class="ic">${ICON.pin}</div><div><b>Address</b><span>${esc(d.address)}</span></div></div>` : ""}
      ${d.hours ? `<div class="row"><div class="ic">${ICON.clock}</div><div><b>Hours</b><span>${esc(d.hours)}</span></div></div>` : ""}
    </div>
    ${noContact || missing.includes("phone number") ? `<a class="add-info" href="${esc(claimUrl)}">${(() => {
      const gaps = ["phone number", "email", "address", "hours"].filter((x) => missing.includes(x));
      return draft
        ? `<b>Your ${esc(listAnd(gaps))} go${gaps.length === 1 ? "es" : ""} here.</b> Fill ${gaps.length === 1 ? "it" : "them"} in on the form to see ${gaps.length === 1 ? "it" : "them"} on your site.`
        : `<b>Your ${esc(listAnd(gaps))} go${gaps.length === 1 ? "es" : ""} here.</b> We couldn't find ${gaps.length === 1 ? "it" : "them"} online.`;
    })()}${draft ? "" : " Add your details and logo &rarr;"}</a>` : ""}
  </div>
  ${withForm ? formHtml("Send us a message", [["Your name"], ["Phone or email"], ["How can we help?", "area"]], "Send message", "Messages go straight to your email.") : mapHtml}
</div>${withForm && mapQuery ? `<div class="wrap" style="margin-top:36px">${mapHtml}</div>` : ""}<div>
</div></section>`;

  // A sample form (not live in the preview).
  function formHtml(title, fields, button, note) {
    return `<div class="card form"><h3>${esc(title)}</h3>${fields.map(([label, kind]) => (kind === "area" ? `<label>${esc(label)}<span class="fake area"></span></label>` : kind === "photo" ? `<label>${esc(label)}<span class="fake photo">${ICON.camera} Add photos</span></label>` : kind === "select" ? `<label>${esc(label)}<span class="fake sel">${esc(svc[0]?.name || "Choose a service")} ▾</span></label>` : `<label>${esc(label)}<span class="fake"></span></label>`)).join("")}<span class="btn btn-c">${esc(button)}</span>${note ? `<p class="hint">${esc(note)}</p>` : ""}</div>`;
  }
  function placeholder(title, text) {
    return `<section><div class="wrap"><div class="ph-box"><b>${esc(title)}</b>${esc(text)}</div></div></section>`;
  }

  // Business-plan power features and The Solution's extras.
  const towns = String(d.area || place || "").split(/,|\band\b|;|\//).map((t) => t.trim()).filter((t) => t && !/^[A-Z]{2}$/.test(t)).slice(0, 8);
  const areasHtml = `<section class="soft"><div class="wrap"><div class="head"><div class="kicker">Where we work</div><h2>Service areas</h2></div>
  <div class="grid">${(towns.length ? towns : ["Your town"]).map((t) => `<div class="card"><div class="ic">${ICON.pin}</div><h3>${esc(`${d.industry || "Service"} in ${t}`)}</h3><p>Its own page, so people searching in ${esc(t)} find you.</p></div>`).join("")}</div></div></section>`;
  const reviewsHtml = reviews.length
    ? `<section class="soft" id="reviews"><div class="wrap"><div class="head"><div class="kicker">Reviews</div><h2>What customers say</h2>${google.rating ? `<p>${google.rating.toFixed(1)} ★ from ${google.count} reviews on <a href="${esc(safeUrl(google.mapsUri) || "#")}" target="_blank" rel="noopener">Google Maps</a></p>` : ""}</div>
  <div class="grid">${reviews.map((r) => `<div class="card review"><div class="stars">${"★".repeat(Math.round(r.rating))}</div><p>${esc(r.text.length > 320 ? `${r.text.slice(0, 317).trimEnd()}…` : r.text)}</p>
    <div class="who">${safeUrl(r.authorPhoto) ? `<img src="${esc(r.authorPhoto)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${safeUrl(r.authorUri) ? `<a href="${esc(r.authorUri)}" target="_blank" rel="noopener">${esc(r.author)}</a>` : esc(r.author)}${r.when ? ` · ${esc(r.when)}` : ""}<br><a href="${esc(safeUrl(r.mapsUri) || safeUrl(google.mapsUri) || "#")}" target="_blank" rel="noopener">Review on Google Maps</a></span></div></div>`).join("")}</div></div></section>`
    : `<section class="soft"><div class="wrap"><div class="head"><div class="kicker">Reviews</div><h2>What customers say</h2></div>
  <div class="grid">${[1, 2, 3].map(() => `<div class="card ph-card"><div class="stars">★★★★★</div><p>Your Google reviews show here, pulled in automatically.</p></div>`).join("")}</div></div></section>`;
  const pricesHtml = `<section><div class="wrap"><div class="head"><div class="kicker">Prices</div><h2>Price list</h2></div>
  <div class="card prices">${(svc.length ? svc : [{ name: "Your service" }, { name: "Another service" }]).map((x) => `<div class="price-row"><span>${esc(x.name)}</span><span class="ph">Your price</span></div>`).join("")}<p class="hint">You can update prices yourself anytime.</p></div></div></section>`;
  const bookHtml = `<section><div class="wrap"><div class="head"><div class="kicker">Book online</div><h2>Request an appointment</h2></div>
  ${formHtml("Pick a time", [["Your name"], ["Phone"], ["Service", "select"], ["Preferred date and time"]], plan === "solution" ? "Pay deposit and book" : "Request booking", plan === "solution" ? "Customers can pay a deposit when they book." : "You get each request by text and email.")}</div></section>`;
  const quoteHtml = `<section><div class="wrap"><div class="head"><div class="kicker">Free quote</div><h2>Get a quote</h2></div>
  ${formHtml("Tell us about the job", [["Your name"], ["Phone"], ["What do you need?", "area"], ["Photos of the job", "photo"]], "Get my quote", "Customers can send photos with their request.")}</div></section>`;
  const shopHtml = `<section class="soft"><div class="wrap"><div class="head"><div class="kicker">Shop</div><h2>Order online</h2></div>
  <div class="grid">${(svc.length ? svc.slice(0, 6) : [{ name: "Your product" }, { name: "Your product" }, { name: "Your product" }]).map((x) => `<div class="card shop"><div class="ph-tile small">Photo</div><h3>${esc(x.name)}</h3><p class="ph">Your price</p><span class="btn btn-c">Add to cart</span></div>`).join("")}</div></div></section>`;
  const loginHtml = `<section><div class="wrap" style="max-width:520px">${formHtml("Customer login", [["Email"], ["Password"]], "Log in", "Customers see their bookings, orders and invoices.")}</div></section>`;

  const PAGE = {
    home: () => (multi
      ? `${heroHtml}${factsHtml}${servicesHtml()}${menuHtml}${reviewsHtml}${aboutHtml(false)}${ctaHtml}`
      : `${heroHtml}${factsHtml}${servicesHtml()}${menuHtml}${aboutHtml(false)}${galleryHtml(false)}${reviews.length ? reviewsHtml : ""}${ctaHtml}${contactHtml(false)}`),
    services: () => `${pageHead("Services", `What we do${d.city ? ` in ${d.city}` : ""}`, sub)}${servicesHtml("Our services")}${menuHtml}${ctaHtml}`,
    about: () => `${pageHead("About", `About ${d.business}`, place ? `Local to ${place}` : "")}${aboutHtml(true)}${galleryHtml(false)}${ctaHtml}`,
    contact: () => `${pageHead("Contact", "Get in touch", d.phone ? `Call ${d.phone} or send us a message.` : "Send us a message and we'll get right back to you.")}${contactHtml(true)}`,
    areas: () => `${pageHead("Service areas", "Where we work", d.area || place)}${areasHtml}${ctaHtml}`,
    gallery: () => `${pageHead("Our work", "Our work", "Photos of recent jobs.")}${galleryHtml(true)}${ctaHtml}`,
    reviews: () => `${pageHead("Reviews", "What customers say", "")}${reviewsHtml}${ctaHtml}`,
    prices: () => `${pageHead("Prices", "Price list", "")}${pricesHtml}${ctaHtml}`,
    book: () => `${pageHead("Book online", "Book online", "")}${bookHtml}`,
    quote: () => `${pageHead("Free quote", "Get a free quote", "")}${quoteHtml}`,
    shop: () => `${pageHead("Shop", "Order online", "")}${shopHtml}`,
    login: () => `${pageHead("Account", "Customer login", "")}${loginHtml}`,
  };
  const pageBody = (PAGE[page] || PAGE.home)();

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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=${font.css}&display=swap" rel="stylesheet">
<style>
  :root { --c: ${color}; --on: ${onColor}; --dark: ${dark}; --ink: #0f172a; --text: #334155; --muted: #64748b; --line: #e2e8f0; --soft: #f8fafc; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; font: 17px/1.65 Inter, system-ui, sans-serif; color: var(--text); background: #fff; }
  h1, h2, h3 { overflow-wrap: anywhere; font-family: "${font.family}", Inter, sans-serif; color: var(--ink); line-height: 1.15; margin: 0 0 .5em; letter-spacing: ${font.spacing}; }
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
  .brand { min-width: 0; display: flex; align-items: center; gap: 12px; font: 800 21px "${font.family}", sans-serif; color: var(--ink); text-decoration: none; }
  .brand img { max-height: 48px; width: auto; }
  nav { display: flex; align-items: center; gap: 28px; font-weight: 600; font-size: 15px; }
  nav a.link { text-decoration: none; color: var(--text); }
  nav .btn { padding: 11px 18px; }
  @media (max-width: 820px) { nav a.link { display: none; } }
  .hero { background: ${heroBg}; background-color: ${dark}; color: #fff; position: relative; }
  .gcredit { font-size: 11px; color: rgba(255,255,255,.85); text-decoration: none; background: rgba(0,0,0,.45); padding: 3px 8px; border-radius: 6px; }
  .hero > .gcredit { position: absolute; right: 12px; bottom: 10px; }
  .pic { position: relative; }
  .pic .cap { position: absolute; right: 8px; bottom: 8px; font-size: 12px; font-weight: 600; color: #fff; background: rgba(0,0,0,.55); padding: 3px 8px; border-radius: 6px; max-width: 70%; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .badges span { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 700; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.25); padding: 6px 12px; border-radius: 99px; }
  .badges svg { width: 16px; height: 16px; }
  .menu { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 28px 48px; }
  .menu-sec h3 { font-size: 22px; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2px solid var(--c); }
  .menu-item { margin-bottom: 14px; }
  .mi-top { display: flex; align-items: baseline; gap: 8px; }
  .mi-top .dots { flex: 1; border-bottom: 1px dotted #cbd5e1; transform: translateY(-4px); }
  .mi-price { font-weight: 800; }
  .menu-item p { margin: 2px 0 0; font-size: 14px; color: var(--muted, #64748b); }
  .pic .gcredit { position: absolute; left: 8px; bottom: 8px; }
  .gsrc { font-size: 13px; color: var(--muted, #64748b); margin-top: -4px; }
  .fact a { color: rgba(255,255,255,.85); font-size: 15px; }
  .review p { font-size: 15px; }
  .review .who { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--muted, #64748b); margin-top: 12px; }
  .review .who img { width: 32px; height: 32px; border-radius: 50%; }
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
  .add-info { display: block; margin-top: 22px; padding: 18px 20px; border: 2px dashed color-mix(in srgb, var(--c) 45%, #fff); border-radius: 14px; color: var(--text); text-decoration: none; background: color-mix(in srgb, var(--c) 5%, #fff); }
  .add-info b { display: block; color: var(--ink); margin-bottom: 2px; }
  .map { border: 0; width: 100%; min-height: 340px; border-radius: 18px; background: var(--soft); }
  nav a.link.on { color: var(--c); font-weight: 800; }
  .btn-line { border-color: var(--line); color: var(--ink); background: #fff; padding: 9px 14px !important; }
  .pagehead .wrap { padding-top: 70px; padding-bottom: 70px; }
  .pagehead h1 { font-size: clamp(34px, 4.6vw, 52px); }
  .ph { color: var(--muted) !important; font-style: italic; }
  .ph-box { border: 2px dashed var(--line); border-radius: 18px; padding: 34px; text-align: center; color: var(--muted); }
  .ph-box b { display: block; color: var(--ink); font-size: 20px; margin-bottom: 6px; }
  .ph-tile { aspect-ratio: 4/3; border: 2px dashed var(--line); border-radius: 14px; display: grid; place-items: center; color: var(--muted); font-size: 15px; background: #fff; }
  .ph-tile.small { margin-bottom: 14px; }
  .ph-card { border-style: dashed; }
  .stars { color: #f59e0b; font-size: 22px; letter-spacing: 2px; margin-bottom: 8px; }
  .form { max-width: 560px; display: grid; gap: 14px; }
  .form h3 { margin-bottom: 4px; }
  .form label { display: grid; gap: 6px; font-weight: 600; font-size: 15px; color: var(--ink); }
  .fake { display: block; height: 46px; border: 1px solid var(--line); border-radius: 10px; background: #fff; padding: 11px 14px; font-weight: 400; color: var(--muted); }
  .fake.area { height: 96px; }
  .fake.photo { display: flex; align-items: center; gap: 8px; border-style: dashed; color: var(--c); font-weight: 700; }
  .form .btn { justify-content: center; }
  .hint { color: var(--muted); font-size: 14px; margin: 0; }
  .prices { max-width: 640px; }
  .price-row { display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--line); font-weight: 600; color: var(--ink); }
  .shop .btn { margin-top: 12px; padding: 10px 16px; }
  .textus { position: fixed; right: 22px; bottom: 22px; display: inline-flex; align-items: center; gap: 8px; background: var(--c); color: var(--on); padding: 14px 20px; border-radius: 99px; font-weight: 800; text-decoration: none; box-shadow: 0 10px 24px rgba(15,23,42,.25); z-index: 20; }
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
${shot || draft ? "" : `<div class="edz"><div class="wrap"><span>This is a <b>free sample homepage</b> EDZ Solutions made for ${esc(d.business)}.${missing.length ? ` We couldn't find your ${esc(listOr(missing))}, so it's kept simple. Add them and we'll put them on your site.` : " Like it? It can be live in about 3 days."}</span><a href="${esc(claimUrl)}">Make it my website &rarr;</a></div></div>`}
${header}
${pageBody}
${plan === "growth" ? `<a class="textus" href="${d.phone ? `sms:${telHref(d.phone).slice(4)}` : "#"}">${ICON.chat} Text us</a>` : ""}
<footer><div class="wrap"><span>&copy; ${year} ${esc(d.business)}${place ? ` &middot; ${esc(place)}` : ""}</span><span>Sample design by <a href="https://www.edzsolutions.com/web-design">EDZ Solutions</a></span></div></footer>
</body>
</html>`;
}

module.exports = { renderPreview, planPages, missingInfo, listOr, esc, safeUrl, hexColor };
