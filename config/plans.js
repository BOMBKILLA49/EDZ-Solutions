// Website plans. Prices are in cents. Each plan's monthly billing starts after
// `trialDays` (about its delivery time), so customers don't pay monthly before launch.

const PLANS = [
  {
    id: "launch",
    name: "Launch",
    setupCents: 9900,
    monthlyCents: 1900,
    trialDays: 7,
    tagline: "Get online fast. As simple as it gets.",
    delivery: "Live in about 3 days",
    cards: 0,
    photos: 6, // photos they can upload on the /start form
    features: [
      "1-page unique website no one else has",
      "Your business logo, hours, map and up to 6 photos",
      "Tap-to-call button and email",
      "Mobile-friendly, secure (SSL) hosting included",
      "Free domain name included, or we connect yours",
      "1 revision before launch",
      "1 small text update a month (hours, prices, phone)",
    ],
    upgradeHint: "Want your own colors, more pages & local SEO? Starter plan adds them.",
  },
  {
    id: "starter",
    name: "Starter",
    setupCents: 25000,
    monthlyCents: 2800,
    trialDays: 14,
    tagline: "A real website for your brand.",
    delivery: "Live in about 7 days",
    cards: 20,
    photos: 15,
    features: [
      "Up to 4 unique pages (Home, Services, About & Contact)",
      "Your logo, colors and fonts",
      "Free domain name included, or we connect yours",
      "Up to 15 photos",
      "Local SEO setup so you show up in search",
      "Contact form sent straight to your email",
      "2 revision rounds before launch",
      "2 content updates a month",
      "20 free metal business cards",
    ],
    upgradeHint: "Want Google Ads, Google Business Profile, unlimited edits & more attention from our experts? Business plan adds them.",
  },
  {
    id: "business",
    name: "Business",
    setupCents: 49900,
    monthlyCents: 4500,
    trialDays: 21,
    popular: true,
    tagline: "More attention, more customers, for established businesses needing help.",
    delivery: "Live in about 14 days",
    cards: 50,
    photos: 40,
    features: [
      "Up to 8 pages with more detail on every service",
      "Free domain name included, or we connect yours",
      "Local SEO pages for the towns and services you want to rank for",
      "Google Business Profile set up and optimized",
      "Google Ads campaign set up (if you want to advertise; ad spend is paid to Google)",
      "One power feature of your choice (see below)",
      "Unlimited page edits, free",
      "Same-day priority support",
      "Quarterly report: visits, calls and form leads",
      "50 free metal business cards",
    ],
    upgradeHint: "Need a custom store, or functions that run your business? The Solution does it all.",
  },
  {
    id: "solution",
    name: "The Solution",
    setupCents: 150000,
    monthlyCents: 13300,
    trialDays: 35,
    tagline: "Everything. A website that runs parts of your business.",
    delivery: "Live in about 15–35 days",
    cards: 150,
    photos: 100,
    features: [
      "Everything in Business",
      "Up to 25 pages",
      "Online store or web app: payments, booking with deposits, customer accounts, price calculators, scheduling and dispatch & more",
      "Backend admin page built for your business",
      "As many power features as you need",
      "Google Ads managed for you every month (ad spend is paid to Google, not EDZ)",
      "Unlimited edits and new features as you grow",
      "Instant priority support",
      "Bi-Monthly strategy call",
      "150 free metal business cards",
    ],
    upgradeHint: null,
  },
];

// The Business plan's "pick one" feature.
const POWER_FEATURES = [
  { id: "booking", label: "Online booking requests" },
  { id: "quote", label: "Quote request form with photo upload" },
  { id: "reviews", label: "Google reviews showcase" },
  { id: "pricelist", label: "Price list or menu you can update yourself" },
  { id: "text", label: "Click-to-text button" },
];

// Side-by-side list for the /start plan summary: every row from every plan. Each plan's
// value is true (has it, shown with `label`), a string (has it, worded for that plan), or
// false (doesn't have it: shown crossed out with `label`). Wording comes from PLANS above.
const COMPARE = [
  { label: "Pages", launch: "1-page unique website no one else has", starter: "Up to 4 unique pages (Home, Services, About & Contact)", business: "Up to 8 pages with more detail on every service", solution: "Up to 25 pages" },
  { label: "Your logo, hours, map and photos", launch: "Your business logo, hours, map and up to 6 photos", starter: "Your logo, hours, map and up to 15 photos", business: true, solution: true },
  { label: "Tap-to-call button and email", launch: true, starter: true, business: true, solution: true },
  { label: "Mobile-friendly, secure (SSL) hosting included", launch: true, starter: true, business: true, solution: true },
  { label: "Free domain name included, or we connect yours", launch: true, starter: true, business: true, solution: true },
  { label: "Your own colors and fonts", launch: false, starter: true, business: true, solution: true },
  { label: "Contact form sent straight to your email", launch: false, starter: true, business: true, solution: true },
  { label: "Local SEO setup so you show up in search", launch: false, starter: true, business: true, solution: true },
  { label: "Changes before launch", launch: "1 revision before launch", starter: "2 revision rounds before launch", business: "Unlimited page edits, free", solution: "Unlimited edits and new features as you grow" },
  { label: "Monthly updates", launch: "1 small text update a month (hours, prices, phone)", starter: "2 content updates a month", business: null, solution: null },
  { label: "Local SEO pages for the towns and services you want to rank for", launch: false, starter: false, business: true, solution: true },
  { label: "Google Business Profile set up and optimized", launch: false, starter: false, business: true, solution: true },
  { label: "Google Ads campaign set up", launch: false, starter: false, business: "Google Ads campaign set up (if you want to advertise; ad spend is paid to Google)", solution: "Google Ads managed for you every month (ad spend is paid to Google, not EDZ)" },
  { label: "Power feature: booking, quote form, reviews, price list or click-to-text", launch: false, starter: false, business: "One power feature of your choice (see below)", solution: "As many power features as you need" },
  { label: "Priority support", launch: false, starter: false, business: "Same-day priority support", solution: "Instant priority support" },
  { label: "Quarterly report: visits, calls and form leads", launch: false, starter: false, business: true, solution: true },
  { label: "Online store or web app: payments, booking with deposits, customer accounts, price calculators, scheduling and dispatch & more", launch: false, starter: false, business: false, solution: true },
  { label: "Backend admin page built for your business", launch: false, starter: false, business: false, solution: true },
  { label: "Bi-Monthly strategy call", launch: false, starter: false, business: false, solution: true },
  { label: "Free metal business cards", launch: false, starter: "20 free metal business cards", business: "50 free metal business cards", solution: "150 free metal business cards" },
];

const planById = (id) => PLANS.find((p) => p.id === id) || null;

module.exports = { PLANS, POWER_FEATURES, COMPARE, planById };
