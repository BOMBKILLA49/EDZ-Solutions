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
      "1-page website from one of our 3 ready-made layouts",
      "Your text, hours, map and up to 6 photos",
      "Tap-to-call button and contact form",
      "Mobile-friendly, secure (SSL) hosting included",
      "We connect your domain",
      "1 revision before launch",
      "1 small text update a month (hours, prices, phone)",
      "Small \"Site by EDZ Solutions\" credit in the footer",
    ],
    upgradeHint: "Want your own logo, colors and more pages? Starter adds them.",
  },
  {
    id: "starter",
    name: "Starter",
    setupCents: 25000,
    monthlyCents: 2800,
    trialDays: 14,
    tagline: "A real website with your brand on it.",
    delivery: "Live in about 7 days",
    cards: 10,
    features: [
      "Up to 3 pages (Home, Services, About/Contact)",
      "Your logo, colors and fonts",
      "Up to 15 photos",
      "Basic Google setup so you show up in search",
      "Contact form sent straight to your email",
      "2 revision rounds before launch",
      "2 content updates a month",
      "No EDZ credit in the footer",
      "10 free metal business cards",
    ],
    upgradeHint: "Want Google Ads, Google Business Profile and unlimited edits? Business adds them.",
  },
  {
    id: "business",
    name: "Business",
    setupCents: 49900,
    monthlyCents: 4500,
    trialDays: 21,
    popular: true,
    tagline: "More attention, more customers, more found on Google.",
    delivery: "Live in about 14 days",
    cards: 25,
    features: [
      "Up to 8 pages with more detail on every service",
      "Local SEO pages for the towns and services you want to rank for",
      "Google Business Profile set up and optimized",
      "Google Ads campaign set up (if you want to advertise; ad spend is paid to Google)",
      "One power feature of your choice (see below)",
      "Unlimited page edits, free",
      "Priority support: replies within 1 business day",
      "Monthly report: visits, calls and form leads",
      "25 free metal business cards",
    ],
    upgradeHint: "Need a store, booking with payments or a custom app? The Solution does it all.",
  },
  {
    id: "solution",
    name: "The Solution",
    setupCents: 150000,
    monthlyCents: 13300,
    trialDays: 45,
    tagline: "Everything. A website that runs part of your business.",
    delivery: "Live in about 30–45 days",
    cards: 50,
    features: [
      "Everything in Business",
      "Unlimited pages",
      "Online store or web app: payments, booking with deposits, customer accounts, price calculators, scheduling and dispatch",
      "As many power features as you need",
      "Google Ads managed for you every month (ad spend paid to Google)",
      "Unlimited edits and new features as you grow",
      "Same-day priority support",
      "Monthly strategy call",
      "50 free metal business cards",
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
