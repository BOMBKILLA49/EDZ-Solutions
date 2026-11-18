// Extras on the /start form: reading a menu photo with AI, the menu's text format, finding the
// customer's Google listing from a link they paste, and checking Google data sent back by the form.

const googlePlaces = require("./googlePlaces");

const MENU_MODEL = process.env.MENU_MODEL || "gpt-5.4-mini";

// Menu text in the form (they can fix anything the AI misread):
//   Breakfast
//   - Avocado toast | $9 | Sourdough, smashed avocado, chili flakes
// Lines starting with "-" are items (name | price | description); other lines start a section.
function parseMenu(text) {
  const sections = [];
  for (const raw of String(text || "").split(/\r?\n/).slice(0, 400)) {
    const line = raw.replace(/[\u0000-\u001f]/g, " ").trim();
    if (!line) continue;
    if (/^[-•*]/.test(line)) {
      const [name, price = "", desc = ""] = line.replace(/^[-•*]\s*/, "").split("|").map((x) => x.trim());
      if (!name) continue;
      if (!sections.length) sections.push({ name: "Menu", items: [] });
      const items = sections[sections.length - 1].items;
      if (items.length < 40) items.push({ name: name.slice(0, 80), price: price.slice(0, 24), desc: desc.slice(0, 200) });
    } else if (sections.length < 20) {
      sections.push({ name: line.replace(/:$/, "").slice(0, 60), items: [] });
    }
  }
  return sections.filter((s) => s.items.length);
}

const menuToText = (sections) =>
  sections.map((s) => [s.name, ...s.items.map((i) => `- ${[i.name, i.price || "", i.desc || ""].join(" | ").replace(/( \| )+$/, "")}`)].join("\n")).join("\n\n");

// Reads menu photos (JPEG buffers) with AI. Copies only what's printed; never invents items or prices.
async function readMenu(openai, images) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["sections"],
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "items"],
          properties: {
            name: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "price", "desc"],
                properties: { name: { type: "string" }, price: { type: "string" }, desc: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };
  const res = await openai.chat.completions.create({
    model: MENU_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "These are photos of a restaurant or café menu. Copy the menu exactly: every section and every item, in order, with the price as printed (e.g. \"$9\", \"$4 / $5\") and the item's printed description. Use an empty string for a missing price or description. Do not add, guess, translate or improve anything. If a photo isn't a menu, return no sections for it.",
          },
          ...images.map((buf) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}`, detail: "high" } })),
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "menu", schema, strict: true } },
  });
  const out = JSON.parse(res.choices?.[0]?.message?.content || "{}");
  return parseMenu(menuToText((out.sections || []).filter((s) => s.items?.length)));
}

// A Google Maps link they pasted → their place ID (free lookup). Short links are followed, Google
// hosts only. Uses the place name and map position in the link when there is one.
const GOOGLE_HOST = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|g\.page|(www\.)?google\.[a-z.]+|maps\.google\.[a-z.]+)$/i;
async function placeIdFromLink(link, fallback) {
  let url;
  try {
    url = new URL(String(link || "").trim());
  } catch {
    return "";
  }
  for (let hop = 0; hop < 5 && GOOGLE_HOST.test(url.hostname); hop++) {
    if (!/goo\.gl|g\.co|g\.page/i.test(url.hostname)) break;
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000) }).catch(() => null);
    const next = r?.headers.get("location");
    if (!next) break;
    url = new URL(next, url);
  }
  if (!GOOGLE_HOST.test(url.hostname)) return "";
  const name = /\/maps\/place\/([^/@]+)/.exec(url.pathname)?.[1];
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url.pathname);
  const q = url.searchParams.get("q") || url.searchParams.get("query");
  const query = name ? decodeURIComponent(name.replace(/\+/g, " ")) : q || "";
  return googlePlaces.findPlaceId({ business: query || fallback.business, address: fallback.address, city: fallback.area }, at ? { lat: Number(at[1]), lng: Number(at[2]) } : null).catch(() => "");
}

// Google content the form sends back with each preview (it got it from us once, so we don't call
// Google on every keystroke). Only shapes and Google-hosted links are allowed through.
const GURL = /^https:\/\/([a-z0-9-]+\.)*(google\.com|googleusercontent\.com|ggpht\.com|goo\.gl)(\/[^\s"'<>]*)?$/i;
function cleanGoogle(g) {
  if (!g || typeof g !== "object") return null;
  const s = (v, n) => String(v || "").slice(0, n);
  const u = (v) => (GURL.test(String(v || "")) ? String(v) : "");
  return {
    mapsUri: u(g.mapsUri),
    rating: Math.min(5, Math.max(0, Number(g.rating) || 0)),
    count: Math.max(0, Math.floor(Number(g.count) || 0)),
    summary: s(g.summary, 400),
    photos: (Array.isArray(g.photos) ? g.photos : []).slice(0, 5).map((p) => ({ url: u(p?.url), author: s(p?.author, 80), authorUri: u(p?.authorUri), mapsUri: u(p?.mapsUri) })).filter((p) => p.url),
    reviews: (Array.isArray(g.reviews) ? g.reviews : []).slice(0, 3).map((r) => ({
      rating: Math.min(5, Math.max(1, Number(r?.rating) || 5)),
      text: s(r?.text, 2000),
      when: s(r?.when, 40),
      author: s(r?.author, 80),
      authorUri: u(r?.authorUri),
      authorPhoto: u(r?.authorPhoto),
      mapsUri: u(r?.mapsUri),
    })).filter((r) => r.text),
  };
}

module.exports = { parseMenu, menuToText, readMenu, placeIdFromLink, cleanGoogle };
