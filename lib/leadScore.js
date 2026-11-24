// How good a call-list business looks, 0–100. Used by the lead finder (drops low scorers before
// they reach the call list), scripts/score-call-list.js (re-scores the existing list) and the
// server (businesses added without a score get one from their trade alone).
//
// Google's rules say only the place ID may be stored, so the rating and review count are used to
// work out the score and then thrown away; only our own score is kept (data.leadScore).

// Trades where one new customer pays for the website many times over.
const TOP = /tow|wreck|auto body|collision|body shop|roof|hvac|heating|air cond|cooling|furnace|tree|concrete|fenc|septic|pest|exterminat|garage door|plumb|electric|contractor|remodel|construct|landscap|lawn care|pool|moving|mover|paint|floor|carpet|transmission|auto repair|car repair|mechanic|\brv\b|boat|marine|locksmith|appliance|weld|glass|windshield|tire|excavat|paving|asphalt|gutter|pressure wash|power wash|siding|drywall|insulation|solar|irrigation|well (drill|service)|handyman|cabinet|countertop/i;
// Low value: booked through apps or Instagram (salons), or sell to other businesses (machine shops).
const LOW = /barber|hair|salon|beauty|nail|lash|brow|wax|tattoo|spa\b|machine shop|machining/i;

const MIN_SCORE = 50; // below this a business is "low priority" (hidden from the call list)

function tradeTier(text) {
  const t = String(text || "");
  return LOW.test(t) ? "low" : TOP.test(t) ? "top" : "mid";
}

// d: the business (industry, source, hours, facebookUrl). google: {rating, reviews} when looked
// up, or null when we don't know (a Facebook-only find, or no Google listing).
function leadScore(d, google = null) {
  const why = [];
  const tier = tradeTier(`${d.industry || ""} ${d.source || ""}`);
  let score = tier === "top" ? 40 : tier === "mid" ? 30 : -10;
  if (tier === "low") why.push("salon/barber/machine shop");
  if (google) {
    const n = google.reviews || 0;
    score += n >= 50 ? 40 : n >= 15 ? 30 : n >= 5 ? 15 : n >= 1 ? 5 : 0;
    if (n < 5) why.push(n ? `only ${n} Google review${n === 1 ? "" : "s"}` : "no Google reviews");
    if (google.rating && n >= 3) {
      if (google.rating < 3.5) (score -= 25), why.push("low Google rating");
      else if (google.rating < 4) score -= 10;
    }
  } else score += 15; // unknown: neither good nor bad
  if (d.hours) score += 5;
  if (d.facebookUrl) score += 5;
  score = Math.max(0, Math.min(100, score));
  return { score, low: score < MIN_SCORE, why: why.join(", ") };
}

module.exports = { leadScore, tradeTier, MIN_SCORE };
