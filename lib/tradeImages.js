// One AI-made stock photo per trade ("plumbing", "barber"...), used as the hero background of
// sample homepages when we have none of the business's own photos. Each trade's photo is made
// once (about 5 cents) and reused for every business in that trade.

const sharp = require("sharp");

// Business categories → one shared photo each, so "Plumber", "Plumbing" and "Plumbing service" match.
const TRADES = [
  ["plumbing", /plumb|drain|sewer|water heater/i, "a plumber in work clothes fixing pipes under a modern kitchen sink, tools laid out"],
  ["hvac", /hvac|heating|air condition|furnace|cooling/i, "an HVAC technician servicing an outdoor air conditioning unit beside a house"],
  ["roofing", /roof|gutter/i, "roofers installing new shingles on a house roof on a clear day"],
  ["electrical", /electric/i, "an electrician working on a residential breaker panel with insulated tools"],
  ["landscaping", /landscap|lawn|mow|yard|garden/i, "a freshly mowed green lawn with neat landscaping in front of a house, lawn mower nearby"],
  ["tree", /tree|stump|arbor/i, "an arborist in safety gear trimming a large tree with a bucket truck nearby"],
  ["pest", /pest|extermin|termite/i, "a pest control technician in uniform spraying the foundation of a house"],
  ["cleaning", /clean|maid|janitor|carpet/i, "a bright, spotless living room being cleaned, cleaning supplies in a caddy"],
  ["towing", /tow|wreck|roadside/i, "a tow truck loading a car onto its flatbed on the side of a road at golden hour"],
  ["autobody", /body shop|collision|auto body|paint and body/i, "a car in an auto body shop paint booth, technician in protective suit"],
  ["autorepair", /auto|mechanic|car repair|transmission|tire|brake|oil change|engine/i, "a mechanic working under the hood of a car in a clean, well-lit repair shop"],
  ["bakery", /bak|pastr|donut|bread|cake/i, "fresh bread and pastries on a wooden bakery counter, warm light"],
  ["restaurant", /restaurant|cafe|coffee|diner|grill|food|bbq|pizza|taco/i, "a welcoming small-town restaurant dining room with plated food on the tables"],
  ["barber", /barber/i, "a classic barbershop with leather barber chairs, mirrors and tools neatly arranged, no people"],
  ["salon", /salon|hair|beauty|nail|spa|lash/i, "a modern hair salon interior with styling chairs and mirrors, no people"],
  ["fitness", /gym|fitness|crossfit|yoga|training|martial/i, "a clean gym with free weights, racks and machines, morning light, no people"],
  ["painting", /paint/i, "a painter rolling fresh paint on an interior wall, drop cloths on the floor"],
  ["flooring", /floor|tile|carpet install/i, "new hardwood flooring being installed in a bright room"],
  ["garagedoor", /garage door/i, "a new garage door on a suburban home, technician adjusting the track"],
  ["fence", /fence|gate/i, "a new wooden privacy fence in a backyard on a sunny day"],
  ["concrete", /concrete|paving|asphalt|masonry/i, "workers smoothing a fresh concrete driveway"],
  ["construction", /contract|construct|remodel|builder|handyman|carpent/i, "a home renovation in progress with framing, tools and a worker measuring"],
  ["appliance", /appliance/i, "a technician repairing a washing machine in a laundry room"],
  ["locksmith", /locksmith|lock|key/i, "a locksmith working on a front door lock with tools"],
  ["pool", /pool|spa service/i, "a sparkling clean backyard swimming pool on a sunny day"],
  ["septic", /septic|portable toilet/i, "a septic service truck parked at a rural home"],
  ["welding", /weld|fabricat|machine shop|metal/i, "a welder at work with bright sparks in a metal fabrication shop"],
  ["smallengine", /small engine|lawn mower repair|outdoor power/i, "a small engine repair workbench with a lawn mower engine and tools"],
  ["upholstery", /upholster/i, "an upholsterer re-covering an armchair in a workshop with fabric rolls"],
  ["florist", /flor|flower/i, "a florist shop counter full of fresh flower bouquets"],
  ["petgrooming", /groom/i, "a happy freshly groomed dog on a grooming table"],
  ["kennel", /kennel|boarding|pet|dog|cat|vet/i, "happy dogs playing in a clean outdoor dog boarding yard"],
  ["equestrian", /equestrian|horse|stable|ranch/i, "horses in a green pasture by a wooden barn"],
  ["glass", /glass|window|windshield|mirror/i, "a technician installing a new window pane"],
  ["signs", /sign|print|graphics|embroider/i, "a sign shop workshop with a large format printer and finished signs"],
  ["jewelry", /jewel/i, "a jewelry store display case with rings and necklaces"],
  ["furniture", /furniture|mattress|home goods|furnish/i, "a furniture store showroom with sofas, tables and lamps"],
  ["hardware", /hardware/i, "neat hardware store aisles with tools and supplies"],
  ["marine", /boat|marine/i, "a boat on a trailer at a marina service dock"],
  ["rv", /\brv\b|camper|trailer/i, "an RV service bay with a camper being repaired"],
  ["moving", /mov|haul/i, "movers carrying boxes from a moving truck to a house"],
];

const tradeKey = (industry) => {
  const hit = TRADES.find(([, re]) => re.test(String(industry || "")));
  return hit ? hit[0] : null;
};

const inFlight = new Map();

// Makes the trade's photo if it doesn't exist yet. Safe to call often; never throws.
function ensureTradeImage(pool, openai, model, industry) {
  const key = tradeKey(industry);
  if (!key || !openai) return Promise.resolve(null);
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    const { rows } = await pool.query("SELECT 1 FROM trade_images WHERE key=$1", [key]);
    if (rows[0]) return key;
    const scene = TRADES.find(([k]) => k === key)[2];
    const result = await openai.images.generate({
      model,
      size: "1536x1024",
      quality: "medium",
      output_format: "jpeg",
      output_compression: 85,
      prompt: `A realistic, professional stock photograph for the homepage of a small local business website: ${scene}. Natural light, authentic and inviting, wide shot with calm space on the left side for a headline. No text, no words, no signs with lettering, no logos, no brand names, no watermarks.`,
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) return null;
    const image = await sharp(Buffer.from(b64, "base64")).resize({ width: 1600 }).jpeg({ quality: 80 }).toBuffer();
    await pool.query("INSERT INTO trade_images (key, image) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING", [key, image]);
    console.log(`trade image made: ${key}`);
    return key;
  })()
    .catch((err) => {
      console.error(`trade image ${key} failed:`, err.message);
      return null;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function hasTradeImage(pool, industry) {
  const key = tradeKey(industry);
  if (!key) return null;
  const { rows } = await pool.query("SELECT 1 FROM trade_images WHERE key=$1", [key]);
  return rows[0] ? key : null;
}

module.exports = { tradeKey, ensureTradeImage, hasTradeImage };
