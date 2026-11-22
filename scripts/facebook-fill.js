#!/usr/bin/env node
// Fills in a call-list business from the Facebook page Ty added (Grok Bot reads the page as a
// logged-out visitor, then runs this to save what it saw):
//   node scripts/facebook-fill.js list                 businesses waiting, as JSON
//   node scripts/facebook-fill.js save <id> <file.json> save what the page shows
//   node scripts/facebook-fill.js blocked <id>          the page showed a login screen
//
// file.json (leave out anything the page doesn't show):
//   { "email": "...", "phone": "...", "about": "...", "services": ["...", "..."], "hours": "...",
//     "logoImage": "https://… profile picture", "bannerImage": "https://… cover photo",
//     "photos": [{ "url": "https://…", "label": "what it shows" }] }
//
// Text fields are only filled when still empty, so Ty's own edits are never overwritten.
// Images are downloaded right away (Facebook image links expire) and stored on the site.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SITE = (process.env.EDZ_URL || "https://www.edzsolutions.com").replace(/\/$/, "");
const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const PASSWORD = (process.env.EDZ_ADMIN_PASSWORD || read(path.join(os.homedir(), ".config/edz/admin_password"))).trim();
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` };

async function api(method, route, body, type = "application/json") {
  const res = await fetch(`${SITE}${route}`, {
    method,
    headers: { ...AUTH, ...(body ? { "Content-Type": type } : {}) },
    body: body && type === "application/json" ? JSON.stringify(body) : body,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${out.error || ""}`);
  return out;
}

// Download an image and store it on the site for this business; returns its new link.
async function copyImage(id, url, kind) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/124 Safari/537.36" } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const type = res.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) throw new Error("not an image");
  const out = await api("POST", `/api/admin/prospects/${id}/upload?kind=${kind}`, Buffer.from(await res.arrayBuffer()), type);
  return out.url;
}

(async () => {
  const [cmd, id, file] = process.argv.slice(2);
  if (cmd === "list") {
    const { businesses } = await api("GET", "/api/admin/facebook-pending");
    console.log(JSON.stringify(businesses.map((b) => ({
      id: b.id,
      business: b.data.business,
      city: [b.data.city, b.data.state].filter(Boolean).join(", "),
      facebookUrl: b.data.facebookUrl,
      alreadyHas: ["phone", "email", "about", "hours", "logoUrl", "heroUrl"].filter((k) => b.data[k]).concat((b.data.services || []).length ? ["services"] : [], (b.data.photoUrls || []).length ? ["photos"] : []),
    })), null, 2));
    return;
  }
  if (cmd === "blocked") {
    await api("POST", `/api/admin/prospects/${id}/info`, { fbRead: "blocked" });
    return console.log("marked: couldn't read (login screen)");
  }
  if (cmd !== "save" || !id || !file) throw new Error("Usage: list | save <id> <file.json> | blocked <id>");

  const found = JSON.parse(fs.readFileSync(file, "utf8"));
  const { businesses } = await api("GET", "/api/admin/facebook-pending");
  const b = businesses.find((x) => x.id === id);
  if (!b) throw new Error("That business isn't waiting for a Facebook read.");
  const d = b.data;
  const update = { fbRead: "done" };
  const filled = [];
  for (const k of ["email", "phone", "about", "hours", "tagline"]) {
    if (found[k] && !d[k]) {
      update[k] = found[k];
      filled.push(k);
    }
  }
  if (Array.isArray(found.services) && found.services.length && !(d.services || []).length) {
    update.services = found.services.map((x) => (typeof x === "string" ? { name: x } : x));
    filled.push("services");
  }
  const failed = [];
  if (found.logoImage && !d.logoUrl) {
    try {
      update.logoUrl = await copyImage(id, found.logoImage, "logo");
      filled.push("logo");
    } catch (err) {
      failed.push(`logo (${err.message})`);
    }
  }
  if (found.bannerImage && !d.heroUrl) {
    try {
      update.heroUrl = await copyImage(id, found.bannerImage, "photo");
      update.heroSeparate = true;
      filled.push("header banner");
    } catch (err) {
      failed.push(`banner (${err.message})`);
    }
  }
  const have = d.photoUrls || [];
  if (Array.isArray(found.photos) && found.photos.length && have.length < 6) {
    const urls = [...have];
    const labels = [...(d.photoLabels || have.map(() => ""))];
    for (const ph of found.photos.slice(0, 6 - have.length)) {
      try {
        urls.push(await copyImage(id, ph.url, "photo"));
        labels.push(ph.label || "");
      } catch (err) {
        failed.push(`photo (${err.message})`);
      }
    }
    if (urls.length > have.length) {
      update.photoUrls = urls;
      update.photoLabels = labels;
      update.heroSeparate = true; // their photos go in the gallery; the header stays as set
      filled.push(`${urls.length - have.length} photo(s)`);
    }
  }
  await api("POST", `/api/admin/prospects/${id}/info`, update);
  console.log(`${d.business}: filled ${filled.join(", ") || "nothing new"}${failed.length ? ` | couldn't copy: ${failed.join(", ")}` : ""}`);
})().catch((err) => {
  console.error(`facebook-fill failed: ${err.message}`);
  process.exit(1);
});
