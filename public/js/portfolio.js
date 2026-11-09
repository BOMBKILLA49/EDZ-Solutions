// Websites built by EDZ Solutions. Add a new site by adding an entry here.
// Optional: add `image: "/img/work/<file>.jpg"` for a screenshot instead of the color tile.
const PORTFOLIO = [
  {
    name: "SelfTow",
    url: "https://www.selftow.com",
    color: "linear-gradient(135deg, #f97316, #9a3412)",
    blurb: "Online towing marketplace with instant quotes, partner pricing, Stripe payments and a dispatch backend.",
    tags: ["Web app", "Payments", "Booking"],
  },
  {
    name: "ExhibitFile",
    url: "https://exhibitfile.com",
    color: "linear-gradient(135deg, #2563eb, #1e1b4b)",
    blurb: "Brand site for an iOS app that helps people organize documentation and evidence for legal cases.",
    tags: ["App marketing", "Privacy policy"],
  },
  {
    name: "NM UTV",
    url: "https://nmutv.com",
    color: "linear-gradient(135deg, #e10600, #111111)",
    blurb: "UTV repair shop site with 79 city pages for local SEO and a full parts shop with filters.",
    tags: ["Local SEO", "Online store"],
  },
  {
    name: "Baca House Brewery",
    url: "https://socorrobrewery.com",
    color: "linear-gradient(135deg, #a16207, #3f2a0d)",
    blurb: "Restaurant and brewery site with menu, drinks list and story of the historic Baca House.",
    tags: ["Restaurant", "Menu"],
  },
  {
    name: "Zia Towing",
    url: "https://www.ziatow.com",
    color: "linear-gradient(135deg, #facc15, #b91c1c)",
    blurb: "24/7 towing and roadside dispatch for rural New Mexico, built to rank for \"tow truck near me\" across Socorro, Catron and Otero counties.",
    tags: ["Local SEO", "Lead generation"],
  },
  {
    name: "Large Transit",
    url: "https://largetransit.com",
    color: "linear-gradient(135deg, #0ea5e9, #0f172a)",
    blurb: "Freight and oversize transportation company site covering FTL/LTL, heavy equipment and industrial hauling, with a free-quote request form.",
    tags: ["Logistics", "Quote form"],
  },
];

function renderPortfolio(el, limit) {
  const items = limit ? PORTFOLIO.slice(0, limit) : PORTFOLIO;
  el.innerHTML = items
    .map((p) => {
      const domain = p.url.replace(/^https?:\/\/(www\.)?/, "");
      const thumb = p.image
        ? `<img class="work-thumb" src="${p.image}" alt="${p.name} website" loading="lazy">`
        : `<div class="work-thumb" style="background:${p.color}">${p.name}</div>`;
      return `<a class="card work card-link" href="${p.url}" target="_blank" rel="noopener">
        ${thumb}
        <div class="work-body">
          <h3>${p.name}</h3>
          <div class="domain">${domain} &#8599;</div>
          <p style="margin:10px 0 0">${p.blurb}</p>
          <div class="tags">${p.tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>
        </div>
      </a>`;
    })
    .join("");
}

document.querySelectorAll("[data-portfolio]").forEach((el) => renderPortfolio(el, Number(el.dataset.portfolio) || 0));
