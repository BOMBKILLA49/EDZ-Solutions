(async function () {
  const $ = (s) => document.querySelector(s);
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

  const params = new URLSearchParams(location.search);
  const wanted = params.get("plan");
  // Arriving from the sample homepage we emailed: fill in what we already know.
  const previewSlug = params.get("preview");
  if (previewSlug) {
    fetch(`/api/preview-info/${encodeURIComponent(previewSlug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info) return;
        for (const [name, value] of Object.entries(info)) {
          const field = document.querySelector(`#project [name="${name}"]`);
          if (field && value && !field.value) field.value = value;
        }
        // No website yet: default to "find me the best domain (free)".
        if (info.domainStatus === "need") {
          $("#domain-status").value = "need";
          $("#domain-status").dispatchEvent(new Event("change"));
        }
        $("#preview-note").hidden = false;
        $("#preview-link").href = `/p/${encodeURIComponent(previewSlug)}?admin=1`;
      });
  }
  $("#plan").innerHTML = plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("#plan").value = plans.some((p) => p.id === wanted) ? wanted : "business";
  $("#feature").innerHTML = powerFeatures.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join("");

  function showPlan() {
    const p = plans.find((x) => x.id === $("#plan").value);
    $("#plan-price").innerHTML = `${money(p.monthlyCents)}<small>/mo + ${money(p.setupCents)} setup</small>`;
    $("#plan-delivery").textContent = p.delivery;
    $("#plan-features").innerHTML = p.features.map((f) => `<li>${withValue(f, p)}</li>`).join("");
    $("#due-today").textContent = money(p.setupCents);
    $("#monthly-start").textContent = `${money(p.monthlyCents)}/mo starts in ${p.trialDays} days, around when your site goes live.`;
    $("#feature-set").hidden = p.id !== "business";
    history.replaceState(null, "", `?plan=${p.id}${previewSlug ? `&preview=${encodeURIComponent(previewSlug)}` : ""}`);
  }
  $("#plan").addEventListener("change", showPlan);
  showPlan();

  $("#domain-status").addEventListener("change", (e) => {
    const need = e.target.value === "need";
    $("#domain-label").textContent = need ? "Any names you like? (optional, we'll pick the best one available)" : "Your domain";
    $("#project [name=domain]").placeholder = need ? "Leave blank and we'll choose" : "yourbusiness.com";
    $("#domain-free").hidden = !need;
  });

  let logo = null;
  $("#logo").addEventListener("change", (e) => {
    const file = e.target.files[0];
    logo = null;
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return showMsg($("#msg"), "That logo is over 5 MB.", false);
    const reader = new FileReader();
    reader.onload = () => {
      logo = { name: file.name, dataUrl: reader.result };
      schedulePreview();
    };
    reader.readAsDataURL(file);
  });

  // ---------- live website preview ----------
  // Their homepage, rendered by the server from the form (plus the sample we made for them, if
  // they came from one) and shown scaled down. Refreshes shortly after they stop typing.
  const frame = $("#sp-frame");
  const iframe = $("#sp-iframe");
  let lastHtml = "";
  function fitPreview() {
    iframe.style.transform = `scale(${frame.clientWidth / 1280})`;
    frame.style.height = `${Math.round(Math.min(1400, 1180) * (frame.clientWidth / 1280))}px`;
  }
  window.addEventListener("resize", fitPreview);
  let timer = null;
  let seq = 0;
  let currentPage = "home";
  $("#sp-pages").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (!b) return;
    currentPage = b.dataset.page;
    refreshPreview();
  });
  // A different plan has different pages: start again from its homepage.
  $("#plan").addEventListener("change", () => {
    currentPage = "home";
    refreshPreview();
  });
  async function refreshPreview() {
    const mine = ++seq;
    frame.classList.add("loading");
    try {
      const out = await postJSON("/api/preview-draft", { ...Object.fromEntries(new FormData($("#project"))), logo: logo?.dataUrl || "", previewSlug, plan: $("#plan").value, page: currentPage });
      if (mine !== seq) return;
      lastHtml = out.html;
      currentPage = out.page;
      // One tab per page in their plan (Launch is a single page, so no tabs).
      const extra = { solution: "and up to 25 pages" }[$("#plan").value];
      $("#sp-pages").innerHTML = out.pages.length > 1
        ? out.pages.map((pg) => `<button type="button" role="tab" data-page="${pg.id}" class="${pg.id === currentPage ? "on" : ""}">${esc(pg.label)}</button>`).join("") + (extra ? `<span class="count">${extra}</span>` : "")
        : "";
      $("#sp-note").textContent = out.pages.length > 1
        ? `Your plan includes ${out.pages.length} pages like these${extra ? " (up to 25)" : ""}. Tap a page to see it. Updates as you fill in the form.`
        : "The Launch plan is one page with everything on it. Updates as you fill in the form.";
      iframe.srcdoc = out.html;
      fitPreview();
      // A new trade's photo is being made; show it once it's ready.
      if (out.tradePending) setTimeout(refreshPreview, 15000);
    } catch {
      /* keep the last preview */
    } finally {
      if (mine === seq) frame.classList.remove("loading");
    }
  }
  const schedulePreview = () => {
    clearTimeout(timer);
    timer = setTimeout(refreshPreview, 600);
  };
  $("#project").addEventListener("input", schedulePreview);
  $("#project").addEventListener("change", schedulePreview);
  $("#sp-open").addEventListener("click", () => {
    if (!lastHtml) return;
    const w = window.open("", "_blank");
    if (w) {
      w.document.open();
      w.document.write(lastHtml.replace("<head>", `<head><base href="${location.origin}/">`));
      w.document.close();
    }
  });
  fitPreview();
  // First render once any prefill from their sample has landed.
  setTimeout(refreshPreview, previewSlug ? 900 : 100);

  $("#project").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $("#pay");
    const body = { ...Object.fromEntries(new FormData(form)), plan: $("#plan").value, logo, previewSlug };
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
