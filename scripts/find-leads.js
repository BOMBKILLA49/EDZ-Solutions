#!/usr/bin/env node
// Finds outreach candidates fast, so Grok Bot only writes up good ones:
//   node scripts/find-leads.js                 run 15 Google searches (trade + city), about 300 businesses
//   node scripts/find-leads.js --searches 40   more searches this run
//
// For each business Google Places returns, it skips chains, sites already checked or contacted,
// and modern-looking sites; then it looks for an email printed on the site. Businesses with NO
// website (or only a Facebook/Yelp-type page) are kept too when they have a phone number, marked
// noWebsite: Grok Bot looks for an email on their Facebook page or listing, and if there is
// none they go on the /admin call list. Survivors are saved, pre-filled, to
// leads/candidates-YYYY-MM-DD-HHMM.json.
// Every domain looked at is added to leads/checked-domains.txt; every search to leads/searched.txt.
//
// Needs a Google Places API (New) key in ~/.config/edz/google_places_key (or GOOGLE_PLACES_KEY).
// Cost: each search is one Text Search Enterprise request (1,000 free a month, then $35 per 1,000).
// Google won't let a free-trial account lower its own daily quota, so this script stops itself at
// PLACES_MONTHLY_LIMIT searches a calendar month (default 900), counted in leads/places-usage.log.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LEADS = path.join(ROOT, "leads");
const SITE = (process.env.EDZ_URL || "https://www.edzsolutions.com").replace(/\/$/, "");
const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const KEY = (process.env.GOOGLE_PLACES_KEY || read(path.join(os.homedir(), ".config/edz/google_places_key"))).trim();
const PASSWORD = (process.env.EDZ_ADMIN_PASSWORD || read(path.join(os.homedir(), ".config/edz/admin_password"))).trim();
const argv = process.argv.slice(2);
const SEARCHES = Number(argv[argv.indexOf("--searches") + 1]) || 15;
const MONTHLY_LIMIT = Number(process.env.PLACES_MONTHLY_LIMIT) || 900;
// Spreads the month's searches out instead of using them all in the first week.
const DAILY_LIMIT = Number(process.env.PLACES_DAILY_LIMIT) || 30;

const { TRADES, CITIES, CHAIN } = require("./lead-lists");

// Builders whose sites already look modern, so our pitch won't land.
const MODERN = /wix\.com|wixstatic|squarespace|shopify|webflow|duda|godaddy\.com\/websites|img1\.wsimg|thryv|hibu|yext|scorpion|townsquare|weebly\.com\/uploads\/.*2[2-9]/i;
const OLD_GENERATOR = /<meta[^>]+generator[^>]+(frontpage|dreamweaver|coffeecup|iweb|homestead|web studio|sitebuilder|microsoft word|netobjects|adobe muse|freeservers|tripod|angelfire|intuit|website pro|yahoo! sitebuilder|imagestyler)/i;

const domainOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

async function get(url, ms = 12000) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(ms), headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", Accept: "text/html" } });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "html")) return null;
    return { url: res.url, html: (await res.text()).slice(0, 600000) };
  } catch {
    return null;
  }
}

// Scores how dated a homepage looks. 3+ counts as outdated: an old copyright year alone isn't
// enough, since many modern sites never update their footer.
function outdated(page, httpsWorks) {
  const h = page.html;
  const reasons = [];
  let score = 0;
  if (!/<meta[^>]+name=["']?viewport/i.test(h)) (score += 3), reasons.push("not built for phones (no viewport)");
  if (!httpsWorks) (score += 2), reasons.push("no https");
  // Only the text people see: script/style code and comments carry library license years
  // ("Copyright 2014 Twitter") that say nothing about when the site was last touched.
  const visible = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ").replace(/<[^>]+>/g, " ");
  const years = [...visible.matchAll(/(?:©|&copy;|&#169;|copyright)[^<]{0,40}?((?:19|20)\d\d)(?:\s*[-–]\s*((?:19|20)\d\d))?/gi)].map((m) => Number(m[2] || m[1]));
  const year = years.length ? Math.max(...years) : null;
  if (year && year <= 2018) (score += 2), reasons.push(`copyright ${year}`);
  else if (year && year <= 2020) (score += 1), reasons.push(`copyright ${year}`);
  if ((h.match(/<table/gi) || []).length >= 5) (score += 1), reasons.push("table layout");
  if (/\.swf\b|shockwave-flash/i.test(h)) (score += 2), reasons.push("Flash");
  const gen = OLD_GENERATOR.exec(h);
  if (gen) (score += 2), reasons.push(`built with ${gen[1]}`);
  if (/<font[\s>]/i.test(h)) (score += 1), reasons.push("<font> tags");
  if (/jquery[-.]?1\.\d/i.test(h)) (score += 1), reasons.push("jQuery 1.x");
  if (year && year >= 2023 && score < 4) score = 0; // recently maintained
  return { score, reasons, year };
}

const BAD_EMAIL = /(example|sentry|wixpress|godaddy|domain\.com|yourdomain|email\.com|noreply|no-reply|donotreply|\.(png|jpe?g|gif|webp|svg)$|@2x|privacy|abuse)/i;
function emailsIn(html, domain) {
  const text = html.replace(/&#64;|\[at\]|\(at\)/gi, "@").replace(/&#46;/g, ".");
  const found = new Set([...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0].toLowerCase()));
  const list = [...found].filter((e) => !BAD_EMAIL.test(e) && e.length < 60);
  // Their own domain first, then free/ISP mail (common for old small-business sites).
  return list.sort((a, b) => (b.endsWith(`@${domain}`) ? 1 : 0) - (a.endsWith(`@${domain}`) ? 1 : 0));
}

async function checkSite(place) {
  const domain = domainOf(place.websiteUri);
  const httpsPage = await get(place.websiteUri.replace(/^http:/, "https:"));
  const page = httpsPage || (await get(place.websiteUri.replace(/^https:/, "http:")));
  if (!page) return { domain, skip: "site didn't load" };
  if (MODERN.test(page.html)) return { domain, skip: "modern site builder" };
  const o = outdated(page, Boolean(httpsPage));
  if (o.score < 3) return { domain, skip: `looks current (score ${o.score})` };
  let emails = emailsIn(page.html, domain);
  if (!emails.length) {
    // Contact/about pages linked from the homepage, or the usual names.
    const links = [...page.html.matchAll(/href=["']([^"'#]*(?:contact|about)[^"'#]*)["']/gi)].map((m) => m[1]).slice(0, 4);
    const tries = [...new Set([...links, "contact.html", "contact-us.html", "contact", "contact-us", "about.html"])].slice(0, 6);
    for (const t of tries) {
      let u;
      try {
        u = new URL(t, page.url).href;
      } catch {
        continue;
      }
      if (domainOf(u) !== domainOf(page.url)) continue;
      const sub = await get(u, 8000);
      if (sub) emails = emailsIn(sub.html, domain);
      if (emails.length) break;
    }
  }
  if (!emails.length) return { domain, skip: "no email printed on site" };
  return { domain, emails, ...o, finalUrl: page.url };
}

async function search(query) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress,places.addressComponents,places.businessStatus,places.regularOpeningHours,places.primaryTypeDisplayName,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery: query, pageSize: 20, regionCode: "US" }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Places search failed: ${out.error?.message || res.status}`);
  return out.places || [];
}

async function knownDomains() {
  const set = new Set(read(path.join(LEADS, "checked-domains.txt")).split(/\s+/).filter(Boolean).map((d) => d.replace(/^www\./, "").toLowerCase()));
  try {
    const res = await fetch(`${SITE}/api/admin/prospect-domains`, { headers: { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` } });
    if (res.ok) {
      const out = await res.json();
      for (const d of out.domains) set.add(d);
      for (const ph of out.phones || []) set.add(`tel:${ph}`);
    }
  } catch {}
  for (const ph of read(path.join(LEADS, "checked-phones.txt")).split(/\s+/).filter(Boolean)) set.add(`tel:${ph}`);
  return set;
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

(async () => {
  if (!KEY) throw new Error("No Google Places key: save it in ~/.config/edz/google_places_key.");
  fs.mkdirSync(LEADS, { recursive: true });
  const searchedFile = path.join(LEADS, "searched.txt");
  const searched = new Set(read(searchedFile).split("\n").filter(Boolean));
  const known = await knownDomains();

  // Every trade × city pair in a fixed shuffled order (so runs spread across the country), minus ones already searched.
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const queries = TRADES.flatMap((t) => CITIES.map((c) => `${t} in ${c.replace(/ (\w\w)$/, ", $1")}`))
    .sort((a, b) => hash(a) - hash(b))
    .filter((q) => !searched.has(q))
    .slice(0, SEARCHES);

  const usageFile = path.join(LEADS, "places-usage.log");
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const usage = read(usageFile).split("\n");
  let usedThisMonth = usage.filter((l) => l.startsWith(month)).length;
  let usedToday = usage.filter((l) => l.startsWith(today)).length;
  console.log(`Google searches used: ${usedToday} of ${DAILY_LIMIT} today, ${usedThisMonth} of ${MONTHLY_LIMIT} this month`);

  const candidates = [];
  const tally = {};
  const newDomains = [];
  const newPhones = [];
  // A business's address parts and the fields every candidate shares.
  const base = (p, q) => {
    const comp = Object.fromEntries((p.addressComponents || []).flatMap((c) => c.types.map((t) => [t, c.shortText])));
    return {
      business: p.displayName.text,
      industry: p.primaryTypeDisplayName?.text || q.split(" in ")[0].replace(/\b\w/g, (c) => c.toUpperCase()),
      city: comp.locality || comp.sublocality || "",
      state: comp.administrative_area_level_1 || "",
      phone: p.nationalPhoneNumber || "",
      address: p.formattedAddress?.replace(/, USA$/, "") || "",
      hours: (p.regularOpeningHours?.weekdayDescriptions || []).join("\n"),
      googleMapsUrl: p.googleMapsUri || "",
      source: `Google Places search: ${q}`,
    };
  };
  for (const q of queries) {
    if (usedThisMonth >= MONTHLY_LIMIT || usedToday >= DAILY_LIMIT) {
      console.log(`Stopped: reached the Google search limit (${usedToday}/${DAILY_LIMIT} today, ${usedThisMonth}/${MONTHLY_LIMIT} this month). Try again tomorrow.`);
      break;
    }
    fs.appendFileSync(usageFile, `${new Date().toISOString()} ${q}\n`);
    usedThisMonth++;
    usedToday++;
    const places = await search(q);
    fs.appendFileSync(searchedFile, `${q}\n`);
    const fresh = [];
    for (const p of places) {
      const name = p.displayName?.text || "";
      const d = p.websiteUri && domainOf(p.websiteUri);
      const phoneKey = String(p.nationalPhoneNumber || "").replace(/\D/g, "").slice(-10);
      const socialOnly = d && /facebook|instagram|yelp|google|linktr|square\.site|business\.site|nextdoor|angi|homeadvisor|thumbtack/.test(d);
      if ((!d || socialOnly) && !(p.businessStatus && p.businessStatus !== "OPERATIONAL") && !CHAIN.test(name)) {
        // No real website: a candidate if it has a phone we haven't seen.
        const why2 = phoneKey.length !== 10 ? "no website or phone" : known.has(`tel:${phoneKey}`) ? "already checked" : null;
        if (why2) {
          tally[why2] = (tally[why2] || 0) + 1;
          continue;
        }
        known.add(`tel:${phoneKey}`);
        newPhones.push(phoneKey);
        candidates.push({
          ...base(p, q),
          noWebsite: true,
          email: "",
          website: "",
          facebookUrl: d && /facebook\.com/.test(d) ? p.websiteUri.replace(/^http:/, "https:") : "",
          otherProfile: socialOnly && !/facebook\.com/.test(d) ? p.websiteUri : "",
        });
        tally["no website (kept for Facebook/call list)"] = (tally["no website (kept for Facebook/call list)"] || 0) + 1;
        continue;
      }
      const why = p.businessStatus && p.businessStatus !== "OPERATIONAL" ? "not operating" : CHAIN.test(name) ? "chain" : known.has(d) ? "already checked" : null;
      if (why) {
        tally[why] = (tally[why] || 0) + 1;
        continue;
      }
      known.add(d);
      newDomains.push(d);
      fresh.push(p);
    }
    const checked = await pool(fresh, 8, async (p) => ({ p, r: await checkSite(p) }));
    for (const { p, r } of checked) {
      if (r.skip) {
        tally[r.skip.replace(/ \(score \d\)/, "")] = (tally[r.skip.replace(/ \(score \d\)/, "")] || 0) + 1;
        continue;
      }
      candidates.push({
        ...base(p, q),
        email: r.emails[0],
        otherEmails: r.emails.slice(1, 4),
        website: r.finalUrl,
        whyOutdated: r.reasons.join(", "),
        outdatedScore: r.score,
      });
    }
    console.log(`${q}: ${places.length} results, ${fresh.length} new sites, ${candidates.length} candidates so far`);
  }

  if (newDomains.length) fs.appendFileSync(path.join(LEADS, "checked-domains.txt"), newDomains.join("\n") + "\n");
  if (newPhones.length) fs.appendFileSync(path.join(LEADS, "checked-phones.txt"), newPhones.join("\n") + "\n");
  // Outdated websites (with an email) first, then no-website businesses.
  candidates.sort((a, b) => (a.noWebsite ? 1 : 0) - (b.noWebsite ? 1 : 0) || (b.outdatedScore || 0) - (a.outdatedScore || 0));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const file = path.join(LEADS, `candidates-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(candidates, null, 2));
  const noSite = candidates.filter((c) => c.noWebsite).length;
  console.log(`\n${queries.length} searches, ${newDomains.length} new websites checked, ${candidates.length - noSite} outdated-site + ${noSite} no-website candidates → ${path.relative(ROOT, file)}`);
  console.log(`skipped: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
})().catch((err) => {
  console.error(`find-leads failed: ${err.message}`);
  process.exit(1);
});
