(async function () {
  const $ = (s) => document.querySelector(s);
  const { plans, powerFeatures, compare } = await (await fetch("/api/plans")).json();
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
    // Every feature from every plan; what this plan doesn't include is crossed out.
    $("#plan-features").innerHTML = compare
      .filter((row) => row[p.id] !== null)
      .map((row) => {
        const v = row[p.id];
        return v === false
          ? `<li class="no"><span class="sr-only">Not included: </span>${esc(row.label)}</li>`
          : `<li class="yes">${withValue(typeof v === "string" ? v : row.label, p)}</li>`;
      })
      .join("");
    // Colors and fonts are Starter-and-up: locked on Launch (and left out of the order).
    const launch = p.id === "launch";
    for (const name of ["colors", "font"]) {
      const field = $(`#project [name=${name}]`);
      field.disabled = launch;
      field.closest("label").classList.toggle("locked", launch);
    }
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

  // ---------- AI logo maker ----------
  $("#ai-logo-open").addEventListener("click", () => {
    $("#ai-logo-panel").hidden = false;
    $("#ai-logo-open").hidden = true;
  });
  $("#ai-logo-make").addEventListener("click", async () => {
    const form = Object.fromEntries(new FormData($("#project")));
    const btn = $("#ai-logo-make");
    const msg = $("#ai-logo-msg");
    msg.className = "msg";
    if (!form.business) return showMsg(msg, "Add your business name first, so it can go on the logo.", false);
    btn.disabled = true;
    btn.textContent = "Making 3 logos… (about 20–40 seconds)";
    try {
      const { jobId } = await postJSON("/api/logo-ai", { business: form.business, industry: form.industry, style: $("#ai-logo-style").value });
      let images = null;
      for (let i = 0; i < 60 && !images; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const res = await fetch(`/api/logo-ai/${jobId}`);
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || "The logo maker hit a snag. Please try again.");
        if (out.status === "done") images = out.images;
      }
      if (!images?.length) throw new Error("The logo maker took too long. Please try again.");
      $("#ai-logo-grid").innerHTML = images.map((src, i) => `<button type="button" data-i="${i}"><img src="${src}" alt="Logo option ${i + 1}">Use this one</button>`).join("");
      $("#ai-logo-grid").dataset.images = JSON.stringify(images);
      showMsg(msg, "Pick the one you like. Check the spelling: AI can get letters wrong. Not quite right? Describe changes above and make 3 more.", true);
    } catch (err) {
      showMsg(msg, err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = "Make 3 more";
    }
  });
  $("#ai-logo-grid").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const images = JSON.parse($("#ai-logo-grid").dataset.images || "[]");
    logo = { name: "ai-logo.png", dataUrl: images[Number(b.dataset.i)] };
    $("#logo").value = "";
    document.querySelectorAll("#ai-logo-grid button").forEach((x) => x.classList.toggle("on", x === b));
    showMsg($("#ai-logo-msg"), "Logo added to your website preview. It comes with your files, ready for your metal business cards too.", true);
    schedulePreview();
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
        : `The Launch plan is one page with everything on it, in our standard colors and font.${$("#project [name=colors]").value.trim() || $("#project [name=font]").value !== "modern" ? " Your own colors and font come with Starter and up." : ""} Updates as you fill in the form.`;
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
