(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const date = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

  async function load() {
    const res = await fetch("/api/account");
    if (res.status === 401) {
      $("#signin").hidden = false;
      $("#account").hidden = true;
      return;
    }
    const acct = await res.json();
    $("#signin").hidden = true;
    $("#account").hidden = false;
    $("#who").textContent = acct.email;
    const opts = (list, sel) => list.map((x) => `<option value="${x.id}"${x.id === sel ? " selected" : ""}>${esc(x.label)}</option>`).join("");
    $("#orders").innerHTML = acct.orders.length
      ? acct.orders.map((o) => `<div class="card order" data-id="${o.id}">
          <div class="art">${o.hasImage ? `<img src="/api/account/orders/${o.id}/front" alt="Your card design" loading="lazy">` : "Your uploaded design file"}</div>
          <div>
            <h3>${esc(o.title)}</h3>
            <div class="meta">${o.qty} ${o.product === "wedding" ? (o.guestCount ? "place cards (one per guest)" : "wedding cards") : "business cards"} · ${esc(o.thickness)} mm · ${esc(o.finishLabel)}${o.hasBack ? " · front &amp; back" : ""}</div>
            <div class="meta">Ordered ${date(o.paidAt)} · ${money(o.totalCents)}</div>
            <span class="status">${esc(o.status)}</span>
            <form class="reorder">
              <label>Quantity<input name="qty" type="number" min="${acct.minQty}" max="${acct.maxQty}" value="${o.qty}" ${o.guestCount ? "disabled title=\"Place cards: one per guest\"" : ""}></label>
              <label>Thickness<select name="thickness">${opts(acct.thicknesses, o.thickness)}</select></label>
              <label>Finish<select name="finish">${opts(acct.finishes, o.finish)}</select></label>
              <label class="promo">Promo code <span class="hint">(optional)</span><input name="promo" autocomplete="off"></label>
              <button class="btn btn-primary wide" type="submit">Reorder this card</button>
            </form>
            <div class="msg" role="status"></div>
          </div>
        </div>`).join("")
      : `<div class="card" style="text-align:center">No orders yet. <a href="/business-cards">Design your first card</a>.</div>`;
  }

  let email = "";
  async function sendCode() {
    try {
      const out = await postJSON("/api/account/code", { email });
      showMsg($("#signin-msg"), out.message, true);
      $("#code-form").hidden = false;
      $("#code").focus();
    } catch (err) {
      showMsg($("#signin-msg"), err.message, false);
    }
  }

  $("#email-form").addEventListener("submit", (e) => {
    e.preventDefault();
    email = $("#email").value.trim();
    sendCode();
  });
  $("#resend").addEventListener("click", (e) => {
    e.preventDefault();
    sendCode();
  });
  $("#code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await postJSON("/api/account/verify", { email, code: $("#code").value });
      await load();
    } catch (err) {
      showMsg($("#signin-msg"), err.message, false);
    }
  });
  $("#logout").addEventListener("click", async () => {
    await postJSON("/api/account/logout", {});
    load();
  });

  $("#orders").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const card = form.closest(".order");
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Starting secure checkout…";
    try {
      const out = await postJSON("/api/account/reorder", { orderId: card.dataset.id, ...Object.fromEntries(new FormData(form)) });
      location.href = out.url;
    } catch (err) {
      showMsg(card.querySelector(".msg"), err.message, false);
      btn.disabled = false;
      btn.textContent = "Reorder this card";
    }
  });

  load();
})();
