#!/usr/bin/env node
// Daily outreach run (Grok Bot runs this; you can too):
//   node scripts/outreach-daily.js leads/2026-11-16.json   add leads, screenshot their sample homepages, send today's emails
//   node scripts/outreach-daily.js --no-send leads/x.json  add + screenshot only
//   node scripts/outreach-daily.js                          just screenshot anything pending and send
//
// Talks to the live site (EDZ_URL, default https://www.edzsolutions.com) with the /admin
// password from ~/.config/edz/admin_password. Screenshots use the Google Chrome on this Mac.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const SITE = (process.env.EDZ_URL || "https://www.edzsolutions.com").replace(/\/$/, "");
const PASSWORD = (process.env.EDZ_ADMIN_PASSWORD || readFile(path.join(os.homedir(), ".config/edz/admin_password"))).trim();
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const noSend = args.includes("--no-send");
const leadFiles = args.filter((a) => !a.startsWith("--"));

function readFile(f) {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

async function api(method, route, body, type = "application/json") {
  const res = await fetch(`${SITE}${route}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`, ...(body ? { "Content-Type": type } : {}) },
    body: body && type === "application/json" ? JSON.stringify(body) : body,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${out.error || ""}`);
  return out;
}

function screenshot(url, file) {
  // A throwaway profile so this never touches (or waits on) your open Chrome windows.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edz-chrome-"));
  return new Promise((resolve, reject) => {
    execFile(
      CHROME,
      ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, "--window-size=1280,1600", "--virtual-time-budget=12000", `--screenshot=${file}`, url],
      { timeout: 90000 },
      (err) => {
        fs.rmSync(profile, { recursive: true, force: true });
        if (err || !fs.existsSync(file)) reject(err || new Error("no screenshot written"));
        else resolve();
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!PASSWORD) throw new Error("No admin password: put it in ~/.config/edz/admin_password or EDZ_ADMIN_PASSWORD.");

  // 1. Add new leads. Duplicates (same email or website as anyone before) are skipped by the server.
  for (const file of leadFiles) {
    const leads = JSON.parse(fs.readFileSync(file, "utf8"));
    const { added, skipped } = await api("POST", "/api/admin/prospects", { prospects: leads });
    console.log(`${file}: added ${added.length}, skipped ${skipped.length}`);
    for (const s of skipped) console.log(`  skipped ${s.business}: ${s.reason}`);
  }

  // 2. Screenshot each new prospect's sample homepage for the email.
  const { prospects } = await api("GET", "/api/admin/prospects?status=new");
  for (const p of prospects) {
    const file = path.join(os.tmpdir(), `edz-shot-${p.slug}.png`);
    try {
      await screenshot(`${SITE}/p/${p.slug}?shot=1`, file);
      await api("POST", `/api/admin/prospects/${p.id}/shot`, fs.readFileSync(file), "image/png");
      console.log(`screenshot ok: ${p.data.business}`);
    } catch (err) {
      console.log(`screenshot FAILED for ${p.data.business}: ${err.message}`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  if (noSend) return console.log("--no-send: not emailing.");

  // 3. Send one at a time, 1–3 minutes apart (bursts look like spam), until the daily limit.
  let sent = 0;
  for (;;) {
    const out = await api("POST", "/api/admin/outreach/send-next");
    if (out.sent) {
      sent++;
      console.log(`sent ${out.sent.email} (${out.sent.business}) ${out.sent.preview}  [${out.sentLast24h}/${out.dailyLimit} today]`);
    } else if (out.bounced) {
      console.log(`bounced, won't retry: ${out.bounced.email} (${out.bounced.business})`);
      continue;
    } else {
      console.log(`stopped: ${out.reason}`);
      break;
    }
    await sleep(60000 + Math.random() * 120000);
  }
  console.log(`done: ${sent} email(s) sent. Track replies and views at ${SITE}/admin`);
})().catch((err) => {
  console.error(`outreach run failed: ${err.message}`);
  process.exit(1);
});
