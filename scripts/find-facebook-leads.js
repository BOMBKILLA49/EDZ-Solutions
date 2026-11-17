#!/usr/bin/env node
// Finds local businesses' Facebook pages through a web search API (never Facebook itself):
//   node scripts/find-facebook-leads.js                 3 searches like "tree service Socorro NM site:facebook.com"
//   node scripts/find-facebook-leads.js --searches 40
//
// Keeps business pages only (no groups, posts, events, Marketplace), skips chains and pages
// already found, and pulls the name, phone and any email from the search snippet. Saves them,
// marked noWebsite, to leads/candidates-fb-YYYYMMDD-HHMM.json for Grok Bot, which opens each
// public page (never logged in) to check for a website, an email and recent activity.
//
// Needs a Brave Search API key in ~/.config/edz/brave_search_key (or BRAVE_SEARCH_KEY).
// Stops itself at BRAVE_DAILY_LIMIT (60) and BRAVE_MONTHLY_LIMIT (1800) searches,
// counted in leads/brave-usage.log; set them to match your Brave plan.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { TRADES, CITIES, CHAIN } = require("./lead-lists");

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
const KEY = (process.env.BRAVE_SEARCH_KEY || read(path.join(os.homedir(), ".config/edz/brave_search_key"))).trim();
const PASSWORD = (process.env.EDZ_ADMIN_PASSWORD || read(path.join(os.homedir(), ".config/edz/admin_password"))).trim();
const argv = process.argv.slice(2);
// Each search returns ~15 pages, so a few searches give Grok Bot plenty to review.
const SEARCHES = Number(argv[argv.indexOf("--searches") + 1]) || 3;
const DAILY_LIMIT = Number(process.env.BRAVE_DAILY_LIMIT) || 60;
const MONTHLY_LIMIT = Number(process.env.BRAVE_MONTHLY_LIMIT) || 1800;

// Facebook paths that are never a business page.
const NOT_A_PAGE = new Set(["groups", "events", "marketplace", "watch", "reel", "reels", "story.php", "permalink.php", "photo.php", "photo", "photos", "videos", "posts", "login", "login.php", "public", "hashtag", "help", "policies", "places", "sharer", "share", "dialog", "plugins", "gaming", "fundraisers", "jobs", "notes", "search"]);

// The page's address, cleaned up (https://www.facebook.com/<page>), or null when it isn't a page.
function pageUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length || NOT_A_PAGE.has(parts[0].toLowerCase()) || (parts[0] === "pages" && parts[1] === "category")) return null;
  if (parts[0] === "profile.php") return u.searchParams.get("id") ? `https://www.facebook.com/profile.php?id=${u.searchParams.get("id")}` : null;
  if (parts[0] === "people" && parts[2]) return `https://www.facebook.com/people/${parts[1]}/${parts[2]}/`;
  if (parts[0] === "pages" && parts.length >= 3) return `https://www.facebook.com/pages/${parts[1]}/${parts[2]}`;
  if (parts[0] === "p" && parts[1]) return `https://www.facebook.com/p/${parts[1]}/`;
  return `https://www.facebook.com/${parts[0]}`;
}

// Same key the server uses (facebookKey in server.js): the page's numeric id when the address
// has one (p/Name-100067..., people/Name/100067...), else the page name: "fb:id:100067…" / "fb:sandovaltrees".
function fbKey(url) {
  const path = url.replace(/^https:\/\/www\.facebook\.com\//, "").replace(/\/+$/, "");
  const id = /(?:^|[-/=])(\d{9,})$/.exec(path);
  return id ? `fb:id:${id[1]}` : `fb:${path.toLowerCase()}`;
}
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|aol|outlook|hotmail|live|msn|icloud|me|mac|comcast|att|sbcglobal|bellsouth|verizon|charter|cox|earthlink|protonmail|proton|zoho|gmx|mail)\.(com|net|es|co)$/i;
const cleanTitle = (t) =>
  String(t || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s*\(@[^)]*\)/g, "")
    .replace(/\s*[|\-–·]\s*(Facebook|Home|About|Reviews|Photos|Posts)\b.*$/i, "")
    .replace(/\s*\|\s*.*$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .trim();

async function search(q) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&country=us`;
  const res = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": KEY } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`search failed (${res.status}): ${out.error?.detail || out.message || ""}`);
  return out.web?.results || [];
}

async function knownKeys() {
  const set = new Set(read(path.join(LEADS, "checked-facebook.txt")).split(/\s+/).filter(Boolean));
  for (const ph of read(path.join(LEADS, "checked-phones.txt")).split(/\s+/).filter(Boolean)) set.add(`tel:${ph}`);
  try {
    const res = await fetch(`${SITE}/api/admin/prospect-domains`, { headers: { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` } });
    if (res.ok) for (const k of (await res.json()).phones || []) set.add(k.startsWith("fb:") ? k : `tel:${k}`);
  } catch {}
  return set;
}

(async () => {
  if (!KEY) throw new Error("No Brave Search key: save it in ~/.config/edz/brave_search_key.");
  fs.mkdirSync(LEADS, { recursive: true });
  const usageFile = path.join(LEADS, "brave-usage.log");
  const usage = read(usageFile).split("\n");
  const today = new Date().toISOString().slice(0, 10);
  let usedToday = usage.filter((l) => l.startsWith(today)).length;
  let usedMonth = usage.filter((l) => l.startsWith(today.slice(0, 7))).length;
  console.log(`Brave searches used: ${usedToday} of ${DAILY_LIMIT} today, ${usedMonth} of ${MONTHLY_LIMIT} this month`);

  const searchedFile = path.join(LEADS, "searched-facebook.txt");
  const searched = new Set(read(searchedFile).split("\n").filter(Boolean));
  const hash = (s) => [...s].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 11);
  const queries = TRADES.flatMap((trade) => CITIES.map((place) => {
    const [, city, state] = /^(.*) (\w\w)$/.exec(place);
    return { q: `${trade} ${place} site:facebook.com`, trade, city, state };
  }))
    .sort((a, b) => hash(a.q) - hash(b.q))
    .filter((x) => !searched.has(x.q))
    .slice(0, SEARCHES);

  const known = await knownKeys();
  const candidates = [];
  const newKeys = [];
  const tally = {};
  const count = (k) => (tally[k] = (tally[k] || 0) + 1);

  for (const { q, trade, city, state } of queries) {
    if (usedToday >= DAILY_LIMIT || usedMonth >= MONTHLY_LIMIT) {
      console.log(`Stopped: reached the Brave search limit (${usedToday}/${DAILY_LIMIT} today, ${usedMonth}/${MONTHLY_LIMIT} this month).`);
      break;
    }
    fs.appendFileSync(usageFile, `${new Date().toISOString()} ${q}\n`);
    usedToday++;
    usedMonth++;
    const results = await search(q);
    fs.appendFileSync(searchedFile, `${q}\n`);
    let kept = 0;
    for (const r of results) {
      const url = pageUrl(r.url);
      if (!url) {
        count("not a business page");
        continue;
      }
      const key = fbKey(url);
      const name = cleanTitle(r.title);
      const text = [r.description, ...(r.extra_snippets || [])].join(" ").replace(/<[^>]+>/g, " ");
      const phone = (/\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/.exec(text) || []).slice(1).join("");
      const email = ((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).find((e) => !/facebook|fb\.com/i.test(e)) || "").toLowerCase();
      const website = (text.replace(/[a-z0-9._%+-]+@/gi, "@").match(/(?<!@)\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:com|net|org|biz|us|co))\b/gi) || [])
        .map((d) => d.replace(/^(https?:\/\/)?(www\.)?/i, "").toLowerCase())
        .find((d) => !/facebook|fb\.com|instagram|yelp|google/i.test(d) && !FREE_MAIL.test(d)) || "";
      if (!name || /^facebook$/i.test(name) || CHAIN.test(name)) {
        count(name && !/^facebook$/i.test(name) ? "chain" : "no name");
        continue;
      }
      if (known.has(key) || (phone && known.has(`tel:${phone}`))) {
        count("already found");
        continue;
      }
      known.add(key);
      newKeys.push(key);
      if (phone) known.add(`tel:${phone}`);
      candidates.push({
        business: name,
        industry: trade.replace(/\b\w/g, (c) => c.toUpperCase()),
        city,
        state,
        phone: phone ? `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}` : "",
        email,
        emailSource: email ? "your Facebook page" : "",
        website: "",
        websiteHint: website, // a site mentioned in the snippet: Grok Bot checks it
        noWebsite: true,
        facebookUrl: url,
        snippet: text.slice(0, 300),
        source: `Facebook page found by web search: ${q}`,
      });
      kept++;
    }
    console.log(`${q}: ${results.length} results, ${kept} new pages, ${candidates.length} so far`);
  }

  if (newKeys.length) fs.appendFileSync(path.join(LEADS, "checked-facebook.txt"), newKeys.join("\n") + "\n");
  // Easiest to reach first: with an email, then a phone, then Facebook-message only.
  const rank = (c) => (c.email ? 0 : c.phone ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const file = path.join(LEADS, `candidates-fb-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(candidates, null, 2));
  console.log(`\n${queries.length} searches, ${candidates.length} Facebook pages → ${path.relative(ROOT, file)}`);
  console.log(`skipped: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
})().catch((err) => {
  console.error(`find-facebook-leads failed: ${err.message}`);
  process.exit(1);
});
