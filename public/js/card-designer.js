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
  // Shows artwork the way the laser makes it: the background of the art is bare metal,
  // and only the marks are drawn, in the color an engraving shows on that metal.
  // Each image is analysed once; switching finishes just repaints.
  const marksCache = new Map();

  function engravingMarks(img) {
    const w = Math.min(img.naturalWidth, 1000);
    const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    const hi = new Float32Array(w * h); // brightest channel
    const lo = new Float32Array(w * h); // darkest channel
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
      // Transparent areas of an upload count as bare metal (white).
      const a = px[i + 3] / 255;
      const over = (c) => c * a + 255 * (1 - a);
      const r = over(px[i]), g = over(px[i + 1]), b = over(px[i + 2]);
      lum[j] = 0.299 * r + 0.587 * g + 0.114 * b;
      hi[j] = Math.max(r, g, b);
      lo[j] = Math.min(r, g, b);
      hist[lum[j] | 0]++;
    }
    const pct = (p) => {
      let n = 0;
      for (let v = 0; v < 256; v++) if ((n += hist[v]) >= p * lum.length) return v;
      return 255;
    };
    // Most of a card is background. If the art is mostly dark (light text on a dark
    // card), the light parts are what gets engraved, so flip it.
    const flip = pct(0.5) < 110;
    const bg = flip ? 255 - pct(0.25) : pct(0.75);
    const ink = flip ? 255 - pct(0.98) : pct(0.02);
    const range = Math.max(bg - ink, 24);
    const level = new Float32Array(w * h);
    for (let j = 0; j < lum.length; j++) {
      // Colored parts of the art (like orange lettering) engrave fully, so judge each
      // pixel by its brightest channel on dark art and its darkest channel on light art.
      const v = flip ? 255 - hi[j] : lo[j];
      // Ignore faint texture the AI paints into its background (brushed-metal streaks).
      level[j] = Math.min(Math.max(((bg - v) / range - 0.15) / 0.85, 0), 1);
    }
    // The laser either marks a spot or doesn't, so in-between shades come out as fine
    // dots. Floyd-Steinberg dithering gives the preview that same grainy look.
    const marks = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = y * w + x;
        const on = level[j] >= 0.5 ? 1 : 0;
        marks[j] = on * 255;
        const err = level[j] - on;
        if (x + 1 < w) level[j + 1] += (err * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) level[j + w - 1] += (err * 3) / 16;
          level[j + w] += (err * 5) / 16;
          if (x + 1 < w) level[j + w + 1] += err / 16;
        }
      }
    }
    return { w, h, marks };
  }

  function paintMarks(canvas, { w, h, marks }, color) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(w, h);
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    for (let i = 0, j = 0; j < marks.length; i += 4, j++) {
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = marks[j];
    }
    ctx.putImageData(out, 0, 0);
  }

  function engravedImage(src, alt, className) {
    const canvas = document.createElement("canvas");
    canvas.className = className;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", alt);
    const finish = (state.catalog && state.catalog.finish.find((f) => f.id === state.finish)) || { engrave: "#2b2f35" };
    const paint = (m) => paintMarks(canvas, m, finish.engrave);
    if (marksCache.has(src)) {
      paint(marksCache.get(src));
    } else {
      const img = new Image();
      img.onload = () => {
        const m = engravingMarks(img);
        marksCache.set(src, m);
        paint(m);
      };
      img.src = src;
    }
    return canvas;
  }

  function renderPreview() {
    card.dataset.finish = state.finish;
    card.querySelectorAll(".engrave, .upload-img").forEach((el) => el.remove());
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
