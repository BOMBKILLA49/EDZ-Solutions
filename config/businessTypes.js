// Kinds of business on the /start form. Each asks its own extra questions; the answers show on the
// website preview (badges under the headline, an order/booking button, a menu) and go to the project.
//   check: a yes/no that becomes a badge ("Free estimates")
//   link:  a button in the hero ("Order online" → their ordering page); `hint` explains it on the form
//   text:  a short fact (years in business, license number...)
//   menu:  food & drink only: photos of the menu, read by AI into a menu section

const TYPES = [
  {
    id: "food",
    label: "Food & drink",
    examples: "Restaurant, café, bakery, bar, food truck",
    servicesLabel: "Specialties to highlight",
    servicesHint: "optional; your full menu goes below",
    menu: true,
    options: [
      { key: "dineIn", type: "check", label: "Dine-in" },
      { key: "takeout", type: "check", label: "Takeout" },
      { key: "delivery", type: "check", label: "Delivery" },
      { key: "catering", type: "check", label: "Catering" },
      { key: "orderLink", type: "link", label: "Where customers order online", hint: "optional: DoorDash, Uber Eats, Grubhub, Toast, Square… Leave blank if you don't take online orders", button: "Order online" },
    ],
  },
  {
    id: "trades",
    label: "Home services & trades",
    examples: "Plumber, electrician, HVAC, roofing, landscaping, cleaning",
    servicesLabel: "Services you offer",
    servicesHint: "one per line; add details after a colon, e.g. \"Water heaters: install and repair\"",
    options: [
      { key: "freeEstimates", type: "check", label: "Free estimates" },
      { key: "licensed", type: "check", label: "Licensed & insured" },
      { key: "emergency", type: "check", label: "24/7 emergency service" },
      { key: "years", type: "text", label: "Years in business", placeholder: "15" },
      { key: "license", type: "text", label: "License number", placeholder: "Optional" },
    ],
  },
  {
    id: "auto",
    label: "Auto & towing",
    examples: "Repair shop, body shop, towing, detailing, tires",
    servicesLabel: "Services you offer",
    servicesHint: "one per line; add details after a colon, e.g. \"Brakes: same-day service\"",
    options: [
      { key: "towing247", type: "check", label: "24/7 towing" },
      { key: "freeEstimates", type: "check", label: "Free estimates" },
      { key: "warranty", type: "check", label: "Warranty on our work" },
      { key: "makes", type: "text", label: "Vehicles you work on", placeholder: "All makes, diesel trucks, RVs…" },
      { key: "years", type: "text", label: "Years in business", placeholder: "15" },
    ],
  },
  {
    id: "beauty",
    label: "Beauty, health & fitness",
    examples: "Salon, barber, spa, nails, gym, massage",
    servicesLabel: "Services and prices",
    servicesHint: "one per line, e.g. \"Men's cut: $25\"",
    options: [
      { key: "walkIns", type: "check", label: "Walk-ins welcome" },
      { key: "appointments", type: "check", label: "By appointment" },
      { key: "bookingLink", type: "link", label: "Where customers book online", hint: "optional: Booksy, Vagaro, Square Appointments, Calendly… Leave blank if you don't take online bookings", button: "Book now" },
    ],
  },
  {
    id: "retail",
    label: "Shop & retail",
    examples: "Boutique, gift shop, hardware, florist",
    servicesLabel: "What you sell",
    servicesHint: "one per line, e.g. \"Fresh flowers: arrangements for every occasion\"",
    options: [
      { key: "pickup", type: "check", label: "In-store pickup" },
      { key: "shipping", type: "check", label: "We ship" },
      { key: "storeLink", type: "link", label: "Where customers shop online", hint: "optional: Etsy, Shopify, Square, Facebook Shop… Leave blank if you don't sell online", button: "Shop online" },
    ],
  },
  {
    id: "other",
    label: "Something else",
    examples: "Professional services, events, pets, anything",
    servicesLabel: "Services or products to list",
    servicesHint: "one per line; add details after a colon",
    options: [
      { key: "freeConsult", type: "check", label: "Free consultation" },
      { key: "years", type: "text", label: "Years in business", placeholder: "Optional" },
    ],
  },
];

const typeById = (id) => TYPES.find((t) => t.id === id) || null;

// The answers to a type's questions, cleaned: { checks: ["Free estimates"], link: {label, url}, facts: [{label, value}] }
function cleanExtras(typeId, input = {}) {
  const t = typeById(typeId);
  const out = { checks: [], link: null, facts: [] };
  if (!t) return out;
  for (const o of t.options) {
    const v = input[o.key];
    if (o.type === "check" && (v === true || v === "on" || v === "true")) out.checks.push(o.label);
    if (o.type === "link" && /^https:\/\/[^\s"'<>]{4,300}$/i.test(String(v || "").trim())) out.link = { label: o.button, url: String(v).trim() };
    if (o.type === "text" && String(v || "").trim()) out.facts.push({ key: o.key, label: o.label, value: String(v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80) });
  }
  return out;
}

// The raw answers (for filling the form back in): checks as true, links and text as strings.
function cleanAnswers(typeId, input = {}) {
  const t = typeById(typeId);
  if (!t || !input || typeof input !== "object") return {};
  return Object.fromEntries(t.options.map((o) => {
    const v = input[o.key];
    return [o.key, o.type === "check" ? v === true || v === "on" || v === "true" : String(v || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, o.type === "link" ? 300 : 80)];
  }).filter(([, v]) => v));
}

module.exports = { TYPES, typeById, cleanExtras, cleanAnswers };
