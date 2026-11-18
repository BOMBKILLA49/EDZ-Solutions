// Hours picker: one row per day with "opens" and "closes" dropdowns, instead of typing hours.
// It writes plain text into the form's hours field, grouping days with the same hours:
//   "Mon–Fri: 9am–5pm\nSat: 10am–2pm\nSun: Closed"
// It also reads that text back (and Google's "Monday: 7:30 AM – 3:30 PM" lines), so saved or
// Google hours fill the dropdowns. Used on /start and in the admin forms.
(function () {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const FULL = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const TIMES = Array.from({ length: 49 }, (_, i) => i * 30); // minutes; 1440 = midnight at day's end
  const label = (m) => {
    if (m === 0 || m === 1440) return "midnight";
    if (m === 720) return "noon";
    const h = Math.floor(m / 60) % 12 || 12;
    return `${h}${m % 60 ? `:${String(m % 60).padStart(2, "0")}` : ""}${m < 720 ? "am" : "pm"}`;
  };
  const clean = (s) => String(s || "").replace(/[   ]/g, " ");

  // "7:30 AM", "9am", "noon" → minutes; `ampm` is used when the time has none ("5" in "5–9pm").
  function minutes(t, ampm) {
    const s = clean(t).toLowerCase().trim();
    if (s === "noon") return 720;
    if (s === "midnight") return 0;
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
    if (!m) return null;
    const half = m[3] ? m[3][0] : ampm;
    if (!half) return null;
    return ((Number(m[1]) % 12) + (half === "p" ? 12 : 0)) * 60 + Number(m[2] || 0);
  }
  const dayIndex = (s) => {
    const k = String(s || "").toLowerCase().trim().slice(0, 3);
    return k.length === 3 ? FULL.findIndex((d) => d.startsWith(k)) : -1;
  };

  // Text → 7 day settings ({closed} / {allDay} / {open, close} / null = not given), or null if it can't be read.
  function parse(text) {
    const days = Array(7).fill(null);
    const lines = clean(text).split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    for (const line of lines) {
      const m = /^([a-z]{3,9})(?:\s*[–-]\s*([a-z]{3,9}))?\s*:\s*(.+)$/i.exec(line);
      if (!m) return null;
      const a = dayIndex(m[1]);
      const b = m[2] ? dayIndex(m[2]) : a;
      if (a < 0 || b < 0) return null;
      const rest = m[3].trim();
      let v;
      if (/^closed$/i.test(rest)) v = { closed: true };
      else if (/24 hours/i.test(rest)) v = { allDay: true };
      else {
        // "7:30 AM – 3:30 PM". Split hours ("11am–2pm, 5–9pm") don't fit one pair of dropdowns,
        // so that text is kept exactly as written.
        const parts = rest.split(/\s*[–-]\s*/).filter(Boolean);
        if (parts.length !== 2) return null;
        const lastHalf = /p/i.test(parts[parts.length - 1]) ? "p" : "a";
        const close = minutes(parts[parts.length - 1]);
        let open = minutes(parts[0], lastHalf);
        if (open !== null && close !== null && open >= close && !/[ap]/i.test(parts[0])) open = minutes(parts[0], "a");
        if (open === null || close === null) return null;
        v = { open, close: close === 0 ? 1440 : close };
      }
      for (let i = a; ; i = (i + 1) % 7) {
        days[i] = { ...v };
        if (i === b) break;
      }
    }
    return days.some(Boolean) ? days : null; // days not mentioned stay blank
  }

  const say = (v) => (v.closed ? "Closed" : v.allDay ? "Open 24 hours" : `${label(v.open)}–${label(v.close)}`);
  // Days left blank ("—") are skipped; all blank → "".
  function format(days) {
    const out = [];
    for (let i = 0; i < 7; ) {
      let j = i;
      while (j + 1 < 7 && days[j + 1] && days[i] && say(days[j + 1]) === say(days[i])) j++;
      if (days[i]) out.push(`${DAYS[i]}${j > i ? `–${DAYS[j]}` : ""}: ${say(days[i])}`);
      i = j + 1;
    }
    return out.join("\n");
  }

  // Puts the picker in `box`, keeping `field` (the form's hours input) up to date.
  // `defaults`: start at Mon–Fri 9–5, weekends closed (the /start form). Without it (admin forms),
  // days start blank so no business is shown hours we made up.
  function mount(box, field, { defaults = false } = {}) {
    const unread = field.value.trim() && !parse(field.value) ? field.value.trim() : "";
    const days = parse(field.value) || DAYS.map((_, i) => (defaults ? (i < 5 ? { open: 540, close: 1020 } : { closed: true }) : null));
    const opt = (m, sel) => `<option value="${m}"${m === sel ? " selected" : ""}>${label(m)}</option>`;
    // A fresh inner box each time, so mounting again (after the form is filled in) doesn't stack listeners.
    const inner = document.createElement("div");
    box.replaceChildren(inner);
    inner.innerHTML = `
      ${unread ? `<p class="hint hp-note">Current hours: ${unread.replace(/[&<>"]/g, "")}. Change any day below to replace them.</p>` : ""}
      <div class="hp-rows">${DAYS.map((d, i) => {
        const v = days[i];
        const state = !v ? "" : v.closed ? "closed" : v.allDay ? "24h" : "open";
        return `<div class="hp-row">
          <b>${d}</b>
          <select data-hp="state" aria-label="${d} opens">
            ${defaults ? "" : `<option value=""${state === "" ? " selected" : ""}>—</option>`}
            <option value="closed"${state === "closed" ? " selected" : ""}>Closed</option>
            <option value="24h"${state === "24h" ? " selected" : ""}>Open 24 hours</option>
            ${TIMES.slice(0, 48).map((m) => opt(m, state === "open" ? v.open : -1)).join("")}
          </select>
          <span class="hp-to"${state === "open" ? "" : " hidden"}>to</span>
          <select data-hp="close" aria-label="${d} closes"${state === "open" ? "" : " hidden"}>${TIMES.slice(1).map((m) => opt(m, v?.close ?? 1020)).join("")}</select>
        </div>`;
      }).join("")}</div>
      <button type="button" class="link-btn hp-copy">Copy Monday's hours to Tuesday–Friday</button>`;
    const write = () => {
      const now = [...inner.querySelectorAll(".hp-row")].map((row) => {
        const s = row.querySelector('[data-hp="state"]').value;
        const times = s !== "" && s !== "closed" && s !== "24h";
        row.querySelector(".hp-to").hidden = !times;
        row.querySelector('[data-hp="close"]').hidden = !times;
        return s === "" ? null : s === "closed" ? { closed: true } : s === "24h" ? { allDay: true } : { open: Number(s), close: Number(row.querySelector('[data-hp="close"]').value) };
      });
      field.value = format(now);
      inner.querySelector(".hp-note")?.remove();
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    inner.addEventListener("change", (e) => {
      if (!e.target.closest("[data-hp]")) return;
      e.stopPropagation(); // the hours field's own change event (from write) is what the form hears
      write();
    });
    inner.querySelector(".hp-copy").addEventListener("click", () => {
      const rows = inner.querySelectorAll(".hp-row");
      const pick = (row, k) => row.querySelector(`[data-hp="${k}"]`);
      for (let i = 1; i < 5; i++) {
        pick(rows[i], "state").value = pick(rows[0], "state").value;
        pick(rows[i], "close").value = pick(rows[0], "close").value;
      }
      write();
    });
    // The /start defaults are shown in the preview right away, so they're real until changed.
    if (defaults && !field.value.trim()) field.value = format(days);
  }

  window.HoursPicker = { mount, parse, format };
})();
