(function () {
  const $ = (s) => document.querySelector(s);
  const state = {
    mode: "ai",
    catalog: null,
    designId: null, // AI design saved on the server
    upload: null, // { name, dataUrl, mime }
    thickness: "0.5",
    finish: "silver",
    qty: 50,
  };
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const card = $("#card");

  // ---------- tabs ----------
  document.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("active", p.dataset.panel === state.mode));
      renderPreview();
    })
  );

  // ---------- options ----------
  function radios(container, name, items, current, label, onPick) {
    container.innerHTML = items
      .map((it) => {
        const { value, html } = label(it);
        return `<label class="opt"><input type="radio" name="${name}" value="${value}" ${String(value) === String(current) ? "checked" : ""}><span>${html}</span></label>`;
      })
      .join("");
    container.addEventListener("change", (e) => onPick(e.target.value));
  }

  async function loadCatalog() {
    const res = await fetch("/api/catalog");
    state.catalog = await res.json();
    const c = state.catalog;
    radios($("#opt-thickness"), "thickness", c.thickness, state.thickness,
      (t) => ({ value: t.id, html: `${t.label}<small>${t.note} · $${t.perCard.toFixed(2)}/card</small>` }),
      (v) => { state.thickness = v; updatePrice(); });
    radios($("#opt-finish"), "finish", c.finish, state.finish,
      (f) => ({ value: f.id, html: `<span class="swatch" style="background:${f.swatch}"></span>${f.label}<small>${f.upcharge ? `+$${f.upcharge.toFixed(2)}/card` : "Included"}</small>` }),
      (v) => { state.finish = v; renderPreview(); updatePrice(); });
    radios($("#opt-qty"), "qty", c.quantity, state.qty,
      (q) => ({ value: q.qty, html: `${q.qty} cards<small>${q.discount ? `Save ${Math.round(q.discount * 100)}%` : "&nbsp;"}</small>` }),
      (v) => { state.qty = Number(v); updatePrice(); });

    if (!c.aiEnabled) {
      $("#generate").disabled = true;
      showMsg($("#ai-msg"), "The AI designer is coming online soon. You can upload your own design in the meantime.", false);
    }
    updatePrice();
    renderPreview();
  }

  async function updatePrice() {
    try {
      const p = await postJSON("/api/price", { thickness: state.thickness, finish: state.finish, qty: state.qty });
      $("#total").textContent = money(p.totalCents);
      $("#each").textContent = `${state.qty} cards · ${money(p.eachCents)} each`;
    } catch {
      $("#total").textContent = "$—";
    }
  }

  // ---------- preview ----------
  // Shows artwork the way the laser will make it: no color, just the engraving on the
  // chosen metal. Dark parts of the art become the engraved marks.
  function engravedImage(src, alt, className) {
    const img = new Image();
    img.className = className;
    img.alt = alt;
    img.src = src;
    if (state.finish === "black") {
      img.style.filter = "grayscale(1) invert(1) contrast(1.1)";
      img.style.mixBlendMode = "screen";
    } else if (state.finish === "gold") {
      img.style.filter = "grayscale(1) sepia(.6) contrast(1.1)";
      img.style.mixBlendMode = "multiply";
    } else {
      img.style.filter = "grayscale(1) contrast(1.1)";
      img.style.mixBlendMode = "multiply";
    }
    return img;
  }

  function renderPreview() {
    card.dataset.finish = state.finish;
    card.querySelectorAll("img").forEach((i) => i.remove());
    const placeholder = $("#placeholder");

    if (state.mode === "ai" && state.designId) {
      card.append(engravedImage(`/api/design-image/${state.designId}`, "Business card design preview", "engrave"));
      placeholder.hidden = true;
    } else if (state.mode === "upload" && state.upload && state.upload.mime !== "application/pdf") {
      card.append(engravedImage(state.upload.dataUrl, "Your uploaded artwork", "upload-img"));
      placeholder.hidden = true;
    } else {
      placeholder.hidden = false;
      placeholder.textContent =
        state.mode === "upload" && state.upload ? `PDF uploaded: ${state.upload.name}` : "Your design appears here";
    }
  }

  // ---------- AI design ----------
  const details = () => Object.fromEntries(new FormData($("#details")));

  document.querySelectorAll("#style-chips button").forEach((b) =>
    b.addEventListener("click", () => {
      const s = $("#style");
      s.value = s.value ? `${s.value.replace(/\.?\s*$/, "")}. ${b.textContent}` : b.textContent;
    })
  );

  // The server starts the design and hands back a job id; check every 2 seconds until it's ready.
  async function waitForDesign(body) {
    const { jobId } = await postJSON("/api/design", body);
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`/api/design/${jobId}`);
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "The designer hit a snag. Please try again.");
      if (out.status === "done") return out;
    }
    throw new Error("The designer is taking too long. Please try again.");
  }

  async function design(body, btn) {
    const msg = $("#ai-msg");
    msg.className = "msg";
    const buttons = [$("#generate"), $("#apply-revision"), $("#new-design")];
    buttons.forEach((b) => (b.disabled = true));
    const label = btn.textContent;
    btn.textContent = "Designing… (about 15–45 seconds)";
    card.classList.add("loading");
    try {
      const out = await waitForDesign(body);
      state.designId = out.designId;
      $("#preview-note").innerHTML = "<strong>Check every letter and number.</strong> AI can misspell. If anything is wrong, ask for a fix below or try a new design.";
      $("#revise").classList.add("show");
      renderPreview();
    } catch (err) {
      showMsg(msg, err.message, false);
    } finally {
      card.classList.remove("loading");
      btn.textContent = label;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  $("#generate").addEventListener("click", (e) => design({ details: details(), style: $("#style").value }, e.currentTarget));
  $("#new-design").addEventListener("click", (e) =>
    design({ details: details(), style: `${$("#style").value} (try a noticeably different layout)` }, e.currentTarget)
  );
  $("#apply-revision").addEventListener("click", (e) => {
    const revision = $("#revision").value.trim();
    if (!revision) return $("#revision").focus();
    design({ details: details(), style: $("#style").value, previousDesignId: state.designId, revision }, e.currentTarget).then(() => {
      $("#revision").value = "";
    });
  });

  // ---------- upload ----------
  const dz = $("#dropzone");
  function takeFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return alertUpload("That file is over 5 MB.");
    const ok = ["image/png", "image/jpeg", "image/svg+xml", "application/pdf"];
    if (!ok.includes(file.type)) return alertUpload("Please upload a PNG, JPG, SVG or PDF.");
    const reader = new FileReader();
    reader.onload = () => {
      state.upload = { name: file.name, mime: file.type, dataUrl: reader.result };
      $("#file-name").textContent = file.name;
      renderPreview();
    };
    reader.readAsDataURL(file);
  }
  function alertUpload(text) {
    $("#file-name").innerHTML = `<span style="color:var(--err)">${text}</span>`;
  }
  $("#file").addEventListener("change", (e) => takeFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => takeFile(e.dataTransfer.files[0]));

  // ---------- checkout ----------
  $("#checkout").addEventListener("click", async (e) => {
    const msg = $("#checkout-msg");
    msg.className = "msg";
    let design;
    let d = details();
    if (state.mode === "ai") {
      if (!state.designId) return showMsg(msg, "Create your design first (step 2), or switch to Upload.", false);
      design = { type: "ai", designId: state.designId };
    } else {
      if (!state.upload) return showMsg(msg, "Upload your artwork first.", false);
      design = { type: "upload", name: state.upload.name, dataUrl: state.upload.dataUrl };
      d = { name: $("#upload-name").value };
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Starting checkout…";
    try {
      const out = await postJSON("/api/checkout", {
        details: d,
        design,
        thickness: state.thickness,
        finish: state.finish,
        qty: state.qty,
        watchLive: $("#watch-live").checked,
        tiktok: $("#tiktok").value,
        notes: $("#notes").value,
      });
      location.href = out.url;
    } catch (err) {
      showMsg(msg, err.message, false);
      btn.disabled = false;
      btn.textContent = "Order & pay securely";
    }
  });

  loadCatalog();
})();
