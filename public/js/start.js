(async function () {
  const $ = (s) => document.querySelector(s);
  const { plans, powerFeatures } = await (await fetch("/api/plans")).json();
  const money = (c) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: c % 100 ? 2 : 0 })}`;
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const wanted = new URLSearchParams(location.search).get("plan");
  $("#plan").innerHTML = plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("#plan").value = plans.some((p) => p.id === wanted) ? wanted : "business";
  $("#feature").innerHTML = powerFeatures.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join("");

  function showPlan() {
    const p = plans.find((x) => x.id === $("#plan").value);
    $("#plan-price").innerHTML = `${money(p.monthlyCents)}<small>/mo + ${money(p.setupCents)} setup</small>`;
    $("#plan-delivery").textContent = p.delivery;
    $("#plan-features").innerHTML = p.features.map((f) => `<li>${esc(f)}</li>`).join("");
    $("#due-today").textContent = money(p.setupCents);
    $("#monthly-start").textContent = `${money(p.monthlyCents)}/mo starts in ${p.trialDays} days, around when your site goes live.`;
    $("#feature-set").hidden = p.id !== "business";
    history.replaceState(null, "", `?plan=${p.id}`);
  }
  $("#plan").addEventListener("change", showPlan);
  showPlan();

  $("#domain-status").addEventListener("change", (e) => {
    $("#domain-label").textContent = e.target.value === "need" ? "Domain you'd like (we'll check if it's available)" : "Your domain";
  });

  let logo = null;
  $("#logo").addEventListener("change", (e) => {
    const file = e.target.files[0];
    logo = null;
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return showMsg($("#msg"), "That logo is over 5 MB.", false);
    const reader = new FileReader();
    reader.onload = () => (logo = { name: file.name, dataUrl: reader.result });
    reader.readAsDataURL(file);
  });

  $("#project").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $("#pay");
    const body = { ...Object.fromEntries(new FormData(form)), plan: $("#plan").value, logo };
    btn.disabled = true;
    btn.textContent = "Starting secure checkout…";
    try {
      const out = await postJSON("/api/plan-checkout", body);
      location.href = out.url;
    } catch (err) {
      showMsg($("#msg"), err.message, false);
      btn.disabled = false;
      btn.textContent = "Continue to secure payment";
    }
  });
})();
