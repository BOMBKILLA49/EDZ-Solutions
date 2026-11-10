// Renders the website plan cards from /api/plans.
(async function () {
  const el = document.getElementById("plan-cards");
  if (!el) return;
  const { plans, powerFeatures } = await (await fetch("/api/plans")).json();
  const money = (c) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: c % 100 ? 2 : 0 })}`;
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // "50 free metal business cards" → "... ($150 value)".
  const withValue = (f, p) => {
    const text = esc(f);
    return p.cardsValueCents && /free metal business cards/i.test(f)
      ? `${text} <strong class="value">(${money(p.cardsValueCents)} value)</strong>`
      : text;
  };
  el.innerHTML = plans
    .map((p) => {
      const extra = p.id === "business"
        ? `<li><strong>Pick your power feature:</strong> ${powerFeatures.map((f) => esc(f.label)).join(" · ")}</li>`
        : "";
      return `<div class="card plan${p.popular ? " popular" : ""}">
        ${p.popular ? '<span class="ribbon">Most popular</span>' : ""}
        <h3>${esc(p.name)}</h3>
        <div class="tagline">${esc(p.tagline)}</div>
        <div class="price">${money(p.monthlyCents)}<small>/mo</small></div>
        <div class="setup">+ ${money(p.setupCents)} one-time setup</div>
        <ul>${p.features.map((f) => `<li>${withValue(f, p)}</li>`).join("")}${extra}</ul>
        <div class="delivery">${esc(p.delivery)}</div>
        ${p.upgradeHint ? `<div class="upgrade">${esc(p.upgradeHint)}</div>` : ""}
        <a class="btn ${p.popular ? "btn-primary" : "btn-dark"}" href="/start?plan=${p.id}">Get started</a>
      </div>`;
    })
    .join("");
})();
