// Business card pricing. PLACEHOLDER numbers — set your real prices here.
// The server recalculates every price from this file, so the browser can't change it.

const cardThickness = [
  { id: "0.3", label: "0.3 mm — Slim", note: "Light and flexible, fits any wallet", perCard: 3.0 },
  { id: "0.5", label: "0.5 mm — Standard", note: "Our most popular weight", perCard: 3.75 },
  { id: "0.8", label: "0.8 mm — Heavy", note: "Rigid, premium feel", perCard: 4.75 },
  { id: "1.0", label: "1.0 mm — Executive", note: "Thick, serious, unforgettable", perCard: 6.0 },
];

const cardFinish = [
  { id: "mirror", label: "Mirror stainless", swatch: "#e4e6e9", engrave: "#3a2f22", upcharge: 0 },
  { id: "black", label: "Matte black", swatch: "#1d1f22", engrave: "#ebe8df", upcharge: 0.5 },
  { id: "gold", label: "Gold", swatch: "#d4af37", engrave: "#4a3608", upcharge: 0.75 },
];

const cardQuantity = [
  { qty: 10, discount: 0 },
  { qty: 25, discount: 0 },
  { qty: 50, discount: 0.1 },
  { qty: 100, discount: 0.2 },
];

// An engraved back costs 25% of the front price per card (75% off).
const BACK_SHARE = 0.25;

function quoteCard({ thickness, finish, qty, back }) {
  const t = cardThickness.find((x) => x.id === thickness);
  const f = cardFinish.find((x) => x.id === finish);
  const q = cardQuantity.find((x) => x.qty === Number(qty));
  if (!t || !f || !q) return null;
  // Stripe charges a whole-cent unit price × quantity, so the total is built the same way.
  const frontCents = Math.round((t.perCard + f.upcharge) * (1 - q.discount) * 100);
  const backCents = back ? Math.round(frontCents * BACK_SHARE) : 0;
  const eachCents = frontCents + backCents;
  return { thickness: t, finish: f, qty: q.qty, frontCents, backCents, eachCents, totalCents: eachCents * q.qty };
}

module.exports = { cardThickness, cardFinish, cardQuantity, quoteCard, BACK_SHARE };
