#!/usr/bin/env node
// Outreach research run (Grok Bot runs this; you can too):
//   node scripts/outreach-daily.js leads/2026-11-16.json    add leads and screenshot their sample homepages
//   node scripts/outreach-daily.js                           screenshot anything pending, show the queue
//   node scripts/outreach-daily.js --send-now leads/x.json   also send right away (normally the site sends
//                                                            on its own: weekdays, 8 AM–2 PM Central)
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
const sendNow = args.includes("--send-now");
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
  // New email prospects need one for the email; call-list ones for their link preview
  // (including ones whose info was edited in /admin, which clears the old picture).
  const prospects = [
    ...(await api("GET", "/api/admin/prospects?status=new")).prospects,
    ...(await Promise.all(["call", "no_answer", "interested"].map((s) => api("GET", `/api/admin/prospects?status=${s}`))))
      .flatMap((r) => r.prospects)
      .filter((p) => p.channel === "call" && !p.has_shot),
  ];
  for (const p of prospects) {
    const file = path.join(os.tmpdir(), `edz-shot-${p.slug}.png`);
    try {
      // Their trade's stock photo first, if they have no photos of their own.
      await api("POST", `/api/admin/prospects/${p.id}/prepare`).catch(() => {});
      await screenshot(`${SITE}/p/${p.slug}?shot=1`, file);
      await api("POST", `/api/admin/prospects/${p.id}/shot`, fs.readFileSync(file), "image/png");
      console.log(`screenshot ok: ${p.data.business}`);
    } catch (err) {
      console.log(`screenshot FAILED for ${p.data.business}: ${err.message}`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  const status = await api("GET", "/api/admin/prospects?status=ready");
  console.log(`queue: ${status.queue} waiting to be emailed`);
  console.log(`call list: ${status.callList} businesses to call (no email)`);
  console.log(`mailboxes: ${status.mailboxes.map((m) => `${m.user} ${m.sent24}/${m.limit}`).join(", ")}`);
  if (!sendNow) return console.log("not sending: the site emails the queue on its own on weekdays.");

  // 3. Send one at a time, 1–3 minutes apart (bursts look like spam), until the daily limit.
  let sent = 0;
  for (;;) {
    const out = await api("POST", "/api/admin/outreach/send-next");
    if (out.sent) {
      sent++;
      console.log(`sent ${out.sent.email} (${out.sent.business}) from ${out.sent.from} ${out.sent.preview}  [${out.sentLast24h}/${out.dailyLimit} today]`);
    } else if (out.bounced) {
      console.log(`bounced, won't retry: ${out.bounced.email} (${out.bounced.business})`);
      continue;
    } else {
      console.log(`stopped: ${out.reason || out.error}`);
      break;
    }
    await sleep(60000 + Math.random() * 120000);
  }
  console.log(`done: ${sent} email(s) sent. Track replies and views at ${SITE}/admin`);
})().catch((err) => {
  console.error(`outreach run failed: ${err.message}`);
  process.exit(1);
});
