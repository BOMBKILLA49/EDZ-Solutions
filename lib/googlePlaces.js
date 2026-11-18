// A business's own Google photos, rating, description and reviews for its sample homepage.
// Google's rules: only the place ID may be stored, so everything else is fetched live each time
// the page is opened (never saved, and never in the stored screenshot). Photos and reviews must
// credit their author and link to Google Maps; the page shows "Google Maps" as the source.
// Prices (Places API New): finding the ID is free (Text Search IDs only); details with reviews are
// $25/1,000 and photos $7/1,000 after 1,000 free a month each. The monthly caps below keep it
// inside the free tier unless raised (GOOGLE_DETAILS_MONTHLY / GOOGLE_PHOTOS_MONTHLY).

const KEY = () => (process.env.GOOGLE_PLACES_KEY || "").trim();
const API = "https://places.googleapis.com/v1";
const PHOTOS = 5; // hero, about and a 3-photo gallery
const CAPS = { details: () => Number(process.env.GOOGLE_DETAILS_MONTHLY || 900), photos: () => Number(process.env.GOOGLE_PHOTOS_MONTHLY || 900) };

async function google(url, opts = {}, ms = 4000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Counts this month's paid calls; false (and nothing counted) when the cap would be passed.
async function take(pool, sku, n) {
  const month = new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `INSERT INTO google_usage (month, sku, n) VALUES ($1, $2, $3)
     ON CONFLICT (month, sku) DO UPDATE SET n = google_usage.n + $3 WHERE google_usage.n + $3 <= $4
     RETURNING n`,
    [month, sku, n, CAPS[sku]()]
  );
  return rows.length > 0 && rows[0].n <= CAPS[sku]();
}

// Finds the business on Google by name and address (free). Returns the place ID or "".
// `near` ({lat, lng}, e.g. from a Maps link they pasted) prefers results around that spot.
// `nameOnly`: the name came from their own Maps link, so it can be searched without a town.
async function findPlaceId(d, near = null, { nameOnly = false } = {}) {
  if (!KEY() || !d.business) return "";
  const where = d.address || [d.city, d.state].filter(Boolean).join(", ");
  if (!where && !near && !nameOnly) return "";
  const out = await google(`${API}/places:searchText`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY(), "X-Goog-FieldMask": "places.id" },
    body: JSON.stringify({
      textQuery: where ? `${d.business}, ${where}` : d.business,
      pageSize: 1,
      ...(near && Number.isFinite(near.lat) && Number.isFinite(near.lng) ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 2000 } } } : {}),
    }),
  });
  return out.places?.[0]?.id || "";
}

// Is the Google listing really this business? (The free search can't return names, so the
// details' name is checked: most of the business's own words must appear in it, or vice versa.)
const words = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|llc|inc|co|company|services?)$/.test(w));
function sameBusiness(a, b) {
  const [x, y] = [words(a), words(b)];
  if (!x.length || !y.length) return false;
  const hit = (from, to) => from.filter((w) => to.includes(w)).length / from.length;
  return Math.max(hit(x, y), hit(y, x)) >= 0.6;
}

// Live Google content for the page, or null. Never throws. `trusted`: the business owner gave us
// this listing themselves (their Google link), so the name check is skipped.
async function placeContent(pool, placeId, business, { trusted = false } = {}) {
  try {
    if (!KEY() || !placeId || !(await take(pool, "details", 1))) return null;
    const p = await google(`${API}/places/${encodeURIComponent(placeId)}`, {
      headers: { "X-Goog-Api-Key": KEY(), "X-Goog-FieldMask": "displayName,googleMapsUri,rating,userRatingCount,editorialSummary,reviews,photos" },
    });
    if (!trusted && !sameBusiness(business, p.displayName?.text)) return null;
    const list = (p.photos || []).slice(0, PHOTOS);
    const photos = list.length && (await take(pool, "photos", list.length))
      ? (await Promise.all(list.map(async (ph) => {
          const m = await google(`${API}/${ph.name}/media?maxWidthPx=1600&skipHttpRedirect=true&key=${KEY()}`).catch(() => null);
          const a = ph.authorAttributions?.[0] || {};
          return m?.photoUri ? { url: m.photoUri, author: a.displayName || "", authorUri: a.uri || "", mapsUri: ph.googleMapsUri || p.googleMapsUri || "" } : null;
        }))).filter(Boolean)
      : [];
    const reviews = (p.reviews || [])
      .filter((r) => r.rating >= 4 && (r.text?.text || r.originalText?.text))
      .slice(0, 3)
      .map((r) => ({
        rating: r.rating,
        text: r.text?.text || r.originalText?.text,
        when: r.relativePublishTimeDescription || "",
        author: r.authorAttribution?.displayName || "A Google user",
        authorUri: r.authorAttribution?.uri || "",
        authorPhoto: r.authorAttribution?.photoUri || "",
        mapsUri: r.googleMapsUri || p.googleMapsUri || "",
      }));
    return {
      mapsUri: p.googleMapsUri || "",
      rating: p.rating || 0,
      count: p.userRatingCount || 0,
      summary: p.editorialSummary?.text || "",
      photos,
      reviews,
    };
  } catch (err) {
    console.error("google place content failed:", err.message);
    return null;
  }
}

module.exports = { findPlaceId, placeContent, sameBusiness };
