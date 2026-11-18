// Website plans. Prices are in cents. Each plan's monthly billing starts after
// `trialDays` (about its delivery time), so customers don't pay monthly before launch.
// Two plans on purpose (simplified 2026-11-18): Website is the sample they saw, finished;
// Website + Growth adds pages and getting found. Bigger custom work (stores, payments,
// dispatch tools) is quoted from the web design page instead of a fixed plan.
// The ids stay "launch" and "growth": "launch" is in every sample-page link already sent.

const PLANS = [
  {
    id: "launch",
    name: "Website",
    setupCents: 9900,
    monthlyCents: 1900,
    trialDays: 7,
    tagline: "Your business online, done for you.",
    delivery: "Live in about 3 days",
    cards: 10,
    photos: 10, // photos they can upload on the /start form
    features: [
      "A one-page website made just for your business",
      "Your logo, colors, photos (up to 10) and Google reviews",
      "Your services, menu or prices, hours and map",
      "Tap-to-call button and a contact form sent to your email",
      "Free domain name included, or we connect yours",
      "Mobile-friendly, secure (SSL) hosting included",
      "Set up so Google can find you",
      "Changes until you're happy before launch, then text us small updates anytime",
      "10 free metal business cards shipped to you",
    ],
    upgradeHint: "Want more pages, a page for every town you serve and help getting found on Google? Website + Growth adds them.",
  },
  {
    id: "growth",
    name: "Website + Growth",
    setupCents: 29900,
    monthlyCents: 4900,
    trialDays: 21,
    popular: true,
    tagline: "More pages, more customers finding you.",
    delivery: "Live in about 14 days",
    cards: 50,
    photos: 40,
    features: [
      "Everything in Website",
      "Up to 8 pages, with a page for each main service",
      "A page for each town you serve, so you show up in local searches",
      "Google Business Profile set up and optimized",
      "Booking requests, quote form with photos, price list and click-to-text, whichever you need",
      "Google Ads campaign set up if you want to advertise (ad spend is paid to Google)",
      "Up to 40 photos and a gallery of your work",
      "Unlimited edits",
      "Same-day priority support",
      "50 free metal business cards shipped to you",
    ],
    upgradeHint: null,
  },
];

// Older plan ids (from links or projects before 2026-11-18) → the plan that replaced them.
const OLD_IDS = { starter: "growth", business: "growth", solution: "growth" };

// Side-by-side list for the /start plan summary: every row from every plan. Each plan's
// value is true (has it, shown with `label`), a string (has it, worded for that plan), or
// false (doesn't have it: shown crossed out with `label`). Wording comes from PLANS above.
const COMPARE = [
  { label: "Pages", launch: "A one-page website made just for your business", growth: "Up to 8 pages, with a page for each main service" },
  { label: "Your logo, colors, photos and Google reviews", launch: "Your logo, colors, photos (up to 10) and Google reviews", growth: "Your logo, colors, up to 40 photos and Google reviews" },
  { label: "Your services, menu or prices, hours and map", launch: true, growth: true },
  { label: "Tap-to-call button and a contact form sent to your email", launch: true, growth: true },
  { label: "Free domain name included, or we connect yours", launch: true, growth: true },
  { label: "Mobile-friendly, secure (SSL) hosting included", launch: true, growth: true },
  { label: "Set up so Google can find you", launch: true, growth: true },
  { label: "Changes", launch: "Changes until you're happy before launch, then text us small updates anytime", growth: "Unlimited edits" },
  { label: "A page for each town you serve, so you show up in local searches", launch: false, growth: true },
  { label: "Google Business Profile set up and optimized", launch: false, growth: true },
  { label: "Booking requests, quote form with photos, price list and click-to-text", launch: false, growth: true },
  { label: "Google Ads campaign set up (ad spend is paid to Google)", launch: false, growth: true },
  { label: "Same-day priority support", launch: false, growth: true },
  { label: "Free metal business cards shipped to you", launch: "10 free metal business cards shipped to you", growth: "50 free metal business cards shipped to you" },
];

const planById = (id) => PLANS.find((p) => p.id === (OLD_IDS[id] || id)) || null;

module.exports = { PLANS, COMPARE, planById };
