// Shipping rates. International and Alaska/Hawaii/Puerto Rico rates are PLACEHOLDERS — set your real prices here.
// All amounts are in cents. Weight tiers are the package's maximum weight in pounds.

const US_FLAT_CENTS = 800; // $8 under the free-shipping threshold
const US_FREE_OVER_CENTS = 10000; // free US shipping when the cards total $100 or more

// Rates by package weight: [max pounds, cents]. Orders heavier than the last tier use the last tier.
const ZONES = {
  hipr: { label: "Alaska, Hawaii & Puerto Rico", tiers: [[1, 1200], [2, 1600], [4, 2400], [8, 3500], [12, 4500]] },
  na: { label: "Canada & Mexico", tiers: [[1, 2500], [2, 3500], [4, 5000], [8, 7500], [12, 9500]] },
  eu: { label: "UK & Europe", tiers: [[1, 3000], [2, 4200], [4, 6000], [8, 9500], [12, 12000]] },
  oc: { label: "Australia & New Zealand", tiers: [[1, 3200], [2, 4500], [4, 6500], [8, 10000], [12, 13000]] },
  world: { label: "Rest of world", tiers: [[1, 3500], [2, 5000], [4, 7000], [8, 11000], [12, 14000]] },
};

const NA = ["CA", "MX"];
const EU = ["GB", "IE", "FR", "DE", "NL", "BE", "LU", "AT", "CH", "IT", "ES", "PT", "DK", "SE", "NO", "FI", "IS", "PL", "CZ", "SK", "HU", "SI", "HR", "RO", "BG", "GR", "CY", "MT", "EE", "LV", "LT", "LI", "MC", "SM", "AD", "VA"];
const OC = ["AU", "NZ"];

// Countries we don't ship to.
const EXCLUDED = ["IR", "IQ", "SY", "KP", "CU", "RU", "BY", "AF", "YE", "LY", "SO", "SD", "SS", "VE", "MM"];

// Countries Stripe Checkout can't collect a shipping address for.
const STRIPE_UNSUPPORTED = ["AS", "CX", "CC", "HM", "MH", "FM", "NF", "MP", "PW", "UM", "VI", "AQ", "BV", "IO", "TF", "GS", "SJ", "PN"];

// ISO 3166-1 alpha-2 codes.
const ALL = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(" ");

const INTERNATIONAL = ALL.filter((c) => !["US", "PR"].includes(c) && !EXCLUDED.includes(c) && !STRIPE_UNSUPPORTED.includes(c));

// Alaska and Hawaii are US states priced by weight, so each gets its own "Ship to"
// choice; Stripe still sees them as the US.
const US_STATES_BY_WEIGHT = { "US-AK": { state: "AK", name: "Alaska" }, "US-HI": { state: "HI", name: "Hawaii" } };

// "Ship to" choices: mainland US, Alaska, Hawaii, Puerto Rico, then countries.
const DESTINATIONS = ["US", "US-AK", "US-HI", "PR", ...INTERNATIONAL];

function zoneFor(dest) {
  if (dest === "US") return "us";
  if (US_STATES_BY_WEIGHT[dest] || dest === "PR") return "hipr";
  if (NA.includes(dest)) return "na";
  if (EU.includes(dest)) return "eu";
  if (OC.includes(dest)) return "oc";
  return "world";
}

// Stainless steel, 3.5 x 2 in card: 45.16 cm² × thickness × 7.9 g/cm³, plus box and padding.
const CARD_AREA_CM2 = 45.16;
const STEEL_G_PER_CM3 = 7.9;
const PACKAGING_G = 150;

function packageWeightLb(thicknessMm, qty) {
  const grams = qty * CARD_AREA_CM2 * (Number(thicknessMm) / 10) * STEEL_G_PER_CM3 + PACKAGING_G;
  return grams / 453.6;
}

// Returns { cents, label, zone, country } or null if we don't ship there.
function quoteShipping({ dest, thickness, qty, cardsTotalCents, waive }) {
  if (!DESTINATIONS.includes(dest)) return null;
  const zone = zoneFor(dest);
  const country = US_STATES_BY_WEIGHT[dest] ? "US" : dest;
  if (waive) return { cents: 0, label: "Shipping included", zone, country };
  if (zone === "us") {
    const free = cardsTotalCents >= US_FREE_OVER_CENTS;
    return { cents: free ? 0 : US_FLAT_CENTS, label: free ? "Free US shipping" : "US shipping", zone, country, freeOverCents: US_FREE_OVER_CENTS };
  }
  const lb = packageWeightLb(thickness, qty);
  const tiers = ZONES[zone].tiers;
  const tier = tiers.find(([max]) => lb <= max) || tiers[tiers.length - 1];
  return { cents: tier[1], label: `${ZONES[zone].label} shipping`, zone, country, weightLb: Math.round(lb * 10) / 10 };
}

// Ship-to choices inside the US (not international).
const isDomestic = (dest) => dest === "US" || dest === "PR" || Boolean(US_STATES_BY_WEIGHT[dest]);

module.exports = { DESTINATIONS, US_STATES_BY_WEIGHT, isDomestic, quoteShipping, US_FREE_OVER_CENTS };
