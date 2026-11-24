#!/usr/bin/env node
// Scores every call-list business (lib/leadScore.js) and moves the weak ones to "Low priority":
//   node scripts/score-call-list.js          look up, score and save
//   node scripts/score-call-list.js --dry    only print what it would do
//
// Businesses with a Google listing (place ID) get one Place Details lookup for their rating and
// review count (Place Details Enterprise: 1,000 free a month; this script stops itself at
// DETAILS_MONTHLY_LIMIT, default 600, counted in leads/places-details-usage.log). The rating and
// count are only used to work out the score, never saved (Google's rules). Others are scored
// on trade, hours and Facebook alone.
// Only "To call" businesses are moved, never ones added by hand; "Move to To call" in /admin undoes it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { leadScore } = require("../lib/leadScore");
const { sameBusiness } = require("../lib/googlePlaces");

const ROOT = path.join(__dirname, "..");
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
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` };
const DRY = process.argv.includes("--dry");
const LIMIT = Number(process.env.DETAILS_MONTHLY_LIMIT) || 600;
const usageFile = path.join(ROOT, "leads", "places-details-usage.log");

async function api(method, route, body) {
  const res = await fetch(`${SITE}${route}`, { method, headers: { ...AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status}`);
  return res.json();
}

let used = read(usageFile).split("\n").filter((l) => l.startsWith(new Date().toISOString().slice(0, 7))).length;
async function google(d) {
  if (!KEY || !d.placeId) return null;
  if (used >= LIMIT) throw new Error(`Reached ${LIMIT} Google lookups this month (DETAILS_MONTHLY_LIMIT).`);
  fs.appendFileSync(usageFile, `${new Date().toISOString()} ${d.placeId}\n`);
  used++;
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(d.placeId)}`, {
    headers: { "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "displayName,rating,userRatingCount" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const p = await res.json();
  // Found by the Google lead finder = the right listing; otherwise check the name matches.
  if (!/^Google/.test(d.source || "") && !sameBusiness(d.business, p.displayName?.text)) return null;
  return { rating: p.rating || 0, reviews: p.userRatingCount || 0 };
}

(async () => {
  const statuses = ["call", "no_answer", "messaged", "interested"];
  const lists = await Promise.all(statuses.map((s) => api("GET", `/api/admin/prospects?status=${s}&limit=500`)));
  const rows = lists.flatMap((r) => r.prospects).filter((p) => p.channel === "call");
  const out = { kept: 0, low: 0, skippedHand: 0 };
  const byStatus = {};
  for (const p of rows) {
    const d = p.data || {};
    const g = await google(d).catch((err) => {
      if (/Reached/.test(err.message)) throw err;
      return null;
    });
    const sc = leadScore(d, g);
    (byStatus[p.status] = byStatus[p.status] || []).push(sc.score);
    const handAdded = /by hand/i.test(d.source || "");
    const low = p.status === "call" && sc.low && !handAdded;
    if (p.status === "call") {
      if (low) out.low++;
      else if (sc.low && handAdded) out.skippedHand++;
      else out.kept++;
    }
    console.log(`${String(sc.score).padStart(3)} ${low ? "LOW " : "    "}${p.status.padEnd(10)} ${d.business} · ${d.industry} · ${g ? `${g.reviews} reviews` : "no Google data"}${sc.why ? ` (${sc.why})` : ""}`);
    if (!DRY) await api("POST", `/api/admin/prospects/${p.id}/priority`, p.status === "call" ? { leadScore: sc.score, lowPriority: low } : { leadScore: sc.score });
  }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  console.log(`\nTo call: ${out.kept} kept, ${out.low} moved to Low priority${out.skippedHand ? `, ${out.skippedHand} low but added by hand (kept)` : ""}${DRY ? " (dry run, nothing saved)" : ""}`);
  console.log(`Average score by status: ${Object.entries(byStatus).map(([k, v]) => `${k} ${avg(v)} (${v.length})`).join(", ")}`);
  console.log(`Google lookups used this month: ${used} of ${LIMIT}`);
})().catch((err) => {
  console.error(`score-call-list failed: ${err.message}`);
  process.exit(1);
});
