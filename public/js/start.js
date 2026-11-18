(async function () {
  const $ = (s) => document.querySelector(s);
  const { plans, compare, businessTypes } = await (await fetch("/api/plans")).json();
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
        // Their kind of business and its answers from the sample (else a guess from what they do).
        const t = typeOf(info.type) ? info.type : info.industry ? guessType(info.industry) || "other" : "";
        if (t) {
          pickType(t);
          for (const [k, v] of Object.entries(info.extras || {})) {
            const el = document.querySelector(`#type-opts [data-x="${k}"]`);
            if (el) el.type === "checkbox" ? (el.checked = Boolean(v)) : (el.value = v);
          }
        }
        if (info.googleUrl) loadGoogle();
        $("#preview-note").hidden = false;
        $("#preview-link").href = `/p/${encodeURIComponent(previewSlug)}?admin=1`;
      });
  }
  $("#plan").innerHTML = plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  // Old links (?plan=starter, business, solution) go to Website + Growth.
  const OLD = { starter: "growth", business: "growth", solution: "growth" };
  $("#plan").value = plans.some((p) => p.id === (OLD[wanted] || wanted)) ? OLD[wanted] || wanted : "growth";

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
    $("#due-today").textContent = money(p.setupCents);
    $("#monthly-start").textContent = `${money(p.monthlyCents)}/mo starts in ${p.trialDays} days, around when your site goes live.`;
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

  // ---------- kind of business: its own questions ----------
  const typeOf = (id) => businessTypes.find((t) => t.id === id);
  $("#type-pick").innerHTML = businessTypes.map((t) => `<button type="button" role="radio" aria-checked="false" data-type="${t.id}"><b>${esc(t.label)}</b><span>${esc(t.examples)}</span></button>`).join("");
  function pickType(id) {
    const t = typeOf(id);
    if (!t) return;
    $("#project [name=type]").value = id;
    document.querySelectorAll("#type-pick button").forEach((b) => {
      b.classList.toggle("on", b.dataset.type === id);
      b.setAttribute("aria-checked", String(b.dataset.type === id));
    });
    const field = (o) => (o.type === "check"
      ? `<label><input type="checkbox" data-x="${o.key}"> ${esc(o.label)}</label>`
      : `<label>${esc(o.label)}${o.hint ? ` <span class="hint">(${esc(o.hint)})</span>` : ""}<input data-x="${o.key}" ${o.type === "link" ? `type="url" placeholder="https://…"` : `placeholder="${esc(o.placeholder || "")}"`}></label>`);
    const checks = t.options.filter((o) => o.type === "check");
    const others = t.options.filter((o) => o.type !== "check");
    const links = others.filter((o) => o.type === "link");
    const texts = others.filter((o) => o.type !== "link");
    $("#type-opts").innerHTML = `${checks.length ? `<div class="checks">${checks.map(field).join("")}</div>` : ""}${texts.length ? `<div class="row">${texts.map(field).join("")}</div>` : ""}${links.map(field).join("")}`;
    $("#services-label").textContent = t.servicesLabel;
    $("#services-hint").textContent = `(${t.servicesHint})`;
    $("#project [name=industry]").placeholder = t.examples;
    $("#menu-box").hidden = !t.menu;
    schedulePreview();
  }
  $("#type-pick").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (b) pickType(b.dataset.type);
  });
  // Typed their kind of business without picking a box: pick the likely one for them.
  const GUESS = [
    ["food", /restaurant|caf|coffee|espresso|bak|\bbar\b|pub|pizza|grill|food|diner|bistro|brew|taco|bbq|catering|donut|juice/i],
    ["auto", /auto|tow|tire|mechanic|body shop|collision|detail|transmission|oil change/i],
    ["beauty", /salon|barber|spa\b|nail|beauty|gym|fitness|massage|lash|tattoo|yoga/i],
    ["retail", /shop|store|boutique|florist|gift|hardware|furniture|jewel|thrift/i],
    ["trades", /plumb|electric|hvac|roof|landscap|lawn|clean|paint|construct|contract|handyman|pest|fence|concrete|floor|tree|pool|septic|weld|garage|locksmith|mov|remodel/i],
  ];
  const guessType = (text) => GUESS.find(([, re]) => re.test(text || ""))?.[0];
  $("#project [name=industry]").addEventListener("change", (e) => {
    if (!$("#project [name=type]").value) pickType(guessType(e.target.value) || "other");
  });
  const extrasNow = () => Object.fromEntries([...document.querySelectorAll("#type-opts [data-x]")].map((el) => [el.dataset.x, el.type === "checkbox" ? el.checked : el.value.trim()]));

  // ---------- photos (each plan allows a number) with what each one shows ----------
  let photos = [];
  const planNow = () => plans.find((x) => x.id === $("#plan").value);
  const biggerPlan = (n) => plans.find((x) => x.photos >= n && x.photos > planNow().photos);
  function renderPhotos() {
    const max = planNow().photos;
    $("#photo-list").innerHTML = photos.map((ph, i) => `<div class="photo-row${i >= max ? " over" : ""}"><img src="${esc(ph.url)}" alt=""><input data-pi="${i}" value="${esc(ph.label)}" maxlength="80" placeholder="What is this? e.g. our storefront, a kitchen we remodeled"><button type="button" class="link-btn" data-premove="${i}">Remove</button></div>`).join("");
    $("#photo-count").textContent = `${Math.min(photos.length, max)} of ${max} on ${planNow().name}`;
    const over = photos.length - max;
    if (over > 0) {
      const up = biggerPlan(photos.length);
      showMsg($("#photo-msg"), `${planNow().name} includes up to ${max} photos. Remove ${over}${up ? `, or switch to ${up.name} for up to ${up.photos}` : ""}. Faded photos won't be used.`, false);
    } else $("#photo-msg").className = "msg";
  }
  async function uploadImage(file, kind) {
    const res = await fetch(`/api/start-upload?kind=${kind}`, { method: "POST", headers: { "Content-Type": file.type || "image/jpeg" }, body: file });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "Upload failed. Please try again.");
    return out;
  }
  $("#photo-files").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    const room = planNow().photos - photos.length;
    if (room <= 0) {
      const up = biggerPlan(photos.length + files.length);
      return showMsg($("#photo-msg"), `${planNow().name} includes up to ${planNow().photos} photos.${up ? ` Want to add more? ${up.name} includes up to ${up.photos}.` : ""}`, false);
    }
    const take = files.slice(0, room);
    showMsg($("#photo-msg"), `Uploading ${take.length} photo${take.length > 1 ? "s" : ""}…`, true);
    try {
      for (const f of take) photos.push({ ...(await uploadImage(f, "photo")), label: "" });
      renderPhotos();
      if (files.length > take.length) {
        const up = biggerPlan(photos.length + files.length - take.length);
        showMsg($("#photo-msg"), `Added ${take.length}. ${planNow().name} includes up to ${planNow().photos} photos.${up ? ` Want to add more? ${up.name} includes up to ${up.photos}.` : ""}`, false);
      } else showMsg($("#photo-msg"), `Added ${take.length}. Add a few words about each one.`, true);
      schedulePreview();
    } catch (err) {
      renderPhotos();
      showMsg($("#photo-msg"), err.message, false);
    }
  });
  $("#photo-list").addEventListener("input", (e) => {
    const i = e.target.dataset.pi;
    if (i !== undefined) photos[Number(i)].label = e.target.value;
  });
  $("#photo-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-premove]");
    if (!b) return;
    photos.splice(Number(b.dataset.premove), 1);
    renderPhotos();
    schedulePreview();
  });
  $("#plan").addEventListener("change", renderPhotos);
  renderPhotos();

  // ---------- menu: photos of it, typed up by AI ----------
  let menuIds = [];
  $("#menu-files").addEventListener("change", async (e) => {
    const files = [...e.target.files].slice(0, 6 - menuIds.length);
    e.target.value = "";
    if (!files.length) return showMsg($("#menu-msg"), "That's the most menu pages we can read at once.", false);
    showMsg($("#menu-msg"), "Uploading your menu…", true);
    try {
      for (const f of files) {
        const up = await uploadImage(f, "menu");
        menuIds.push(up.id);
        $("#menu-thumbs").insertAdjacentHTML("beforeend", `<img src="${esc(up.url)}" alt="Menu page">`);
      }
      showMsg($("#menu-msg"), "Reading your menu with AI… (about 10–30 seconds)", true);
      const out = await postJSON("/api/start-menu", { ids: menuIds });
      $("#project [name=menu]").value = out.text;
      showMsg($("#menu-msg"), `Found ${out.items} items. Check them below and fix anything that's off. It's on your preview.`, true);
      schedulePreview();
    } catch (err) {
      showMsg($("#menu-msg"), err.message, false);
    }
  });

  // ---------- Google reviews from their Maps link ----------
  let google = null;
  let placeId = "";
  async function loadGoogle() {
    const url = $("#project [name=googleUrl]").value.trim();
    google = null;
    placeId = "";
    if (!url) return ($("#google-msg").className = "msg"), schedulePreview();
    const f = Object.fromEntries(new FormData($("#project")));
    showMsg($("#google-msg"), "Looking up your Google listing…", true);
    try {
      const out = await postJSON("/api/start-google", { url, business: f.business, address: f.address, area: f.area });
      google = out.google;
      placeId = out.placeId;
      showMsg($("#google-msg"), google.count ? `Found it: ${google.rating.toFixed(1)} ★ from ${google.count} reviews. Your rating and reviews are on your preview.` : "Found your listing. Your reviews show here once you have some.", true);
    } catch (err) {
      showMsg($("#google-msg"), err.message, false);
    }
    schedulePreview();
  }
  $("#project [name=googleUrl]").addEventListener("change", loadGoogle);

  // Everything above, for the preview and the order.
  const extraBody = () => ({
    type: $("#project [name=type]").value,
    extras: extrasNow(),
    photos: photos.slice(0, planNow().photos).map(({ url, label }) => ({ url, label })),
    menuImageIds: menuIds,
    google,
    placeId,
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
      const out = await postJSON("/api/preview-draft", { ...Object.fromEntries(new FormData($("#project"))), ...extraBody(), logo: logo?.dataUrl || "", previewSlug, plan: $("#plan").value, page: currentPage });
      if (mine !== seq) return;
      lastHtml = out.html;
      currentPage = out.page;
      // One tab per page in their plan (Website is a single page, so no tabs).
      $("#sp-pages").innerHTML = out.pages.length > 1
        ? out.pages.map((pg) => `<button type="button" role="tab" data-page="${pg.id}" class="${pg.id === currentPage ? "on" : ""}">${esc(pg.label)}</button>`).join("")
        : "";
      $("#sp-note").textContent = out.pages.length > 1
        ? `Website + Growth includes up to 8 pages like these. Tap a page to see it. Updates as you fill in the form.`
        : `The Website plan is one page with everything on it. Updates as you fill in the form.`;
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
    if (photos.length > planNow().photos) {
      const up = biggerPlan(photos.length);
      $("#photo-msg").scrollIntoView({ block: "center" });
      return showMsg($("#msg"), `${planNow().name} includes up to ${planNow().photos} photos and you added ${photos.length}. Remove ${photos.length - planNow().photos}${up ? `, or switch to ${up.name}` : ""}.`, false);
    }
    const body = { ...Object.fromEntries(new FormData(form)), ...extraBody(), google: undefined, plan: $("#plan").value, logo, previewSlug };
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
