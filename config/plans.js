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
    features: [
      "1-page enique website no one else has",
      "Your business logo, hours, map and up to 6 photos",
      "Tap-to-call button and email",
      "Mobile-friendly, secure (SSL) hosting included",
      "We connect your domain",
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
    cards: 10,
    features: [
      "Up to 4 enique pages (Home, Services, About & Contact)",
      "Your logo, colors and fonts",
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
    cards: 25,
    features: [
      "Up to 8 pages with more detail on every service",
      "Local SEO pages for the towns and services you want to rank for",
      "Google Business Profile set up and optimized",
      "Google Ads campaign set up (if you want to advertise; ad spend is paid to Google)",
      "One power feature of your choice (see below)",
      "Unlimited page edits, free",
      "Priority support: Same day priority support",
      "Quartly report: visits, calls and form leads",
      "50 free metal business cards",
    ],
    upgradeHint: "Need a custom store, or functions that run your business? The Solution does it all.",
  },
  {
    id: "solution",
    name: "The Solution",
    setupCents: 150000,
    monthlyCents: 13300,
    trialDays: 45,
    tagline: "Everything. A website that runs parts of your business.",
    delivery: "Live in about 15-35 days",
    cards: 50,
    features: [
      "Everything in Business",
      "Up to 25 pages",
      "Online store or web app: payments, booking with deposits, customer accounts, price calculators, scheduling and dispatch & more",
      "Backend Admin Page built for your business",
      "As many power features as you need",
      "Google Ads managed for you every month (ad spend paid to Google not EDZ)",
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

const planById = (id) => PLANS.find((p) => p.id === id) || null;

module.exports = { PLANS, POWER_FEATURES, planById };
