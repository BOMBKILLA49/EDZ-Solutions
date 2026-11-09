// Shared header + footer so every page stays in sync.
// PLACEHOLDER: set the real TikTok handle and contact email here.
const SITE = {
  tiktok: "edzsolutions",
  email: "info@edzsolutions.com",
};

(function () {
  const here = location.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";
  const links = [
    ["/", "Home"],
    ["/web-design", "Web Design"],
    ["/laser", "Laser Engraving"],
    ["/business-cards", "Business Cards"],
    ["/live", "Live", "live-link"],
  ];
  const nav = links
    .map(([href, label, cls]) => `<a href="${href}" class="${cls || ""}${here === href ? " active" : ""}">${label}</a>`)
    .join("");

  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `<div class="wrap">
      <a class="brand" href="/"><span class="brand-mark">EDZ</span>EDZ Solutions</a>
      <button class="nav-toggle" aria-label="Menu" aria-expanded="false">&#9776;</button>
      <nav class="nav">${nav}</nav>
    </div>`;
  document.body.prepend(header);
  const toggle = header.querySelector(".nav-toggle");
  toggle.addEventListener("click", () => {
    const open = header.querySelector(".nav").classList.toggle("open");
    toggle.setAttribute("aria-expanded", open);
  });

  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `<div class="wrap">
      <div class="footer-grid">
        <div>
          <a class="brand" href="/"><span class="brand-mark">EDZ</span>EDZ Solutions</a>
          <p style="margin-top:14px;max-width:340px">Websites that bring in customers, and metal laser engraving built live on TikTok.</p>
        </div>
        <div><h4>Services</h4><ul>
          <li><a href="/web-design">Web design</a></li>
          <li><a href="/laser">Laser engraving</a></li>
          <li><a href="/business-cards">Metal business cards</a></li>
        </ul></div>
        <div><h4>Company</h4><ul>
          <li><a href="/#work">Our work</a></li>
          <li><a href="/live">TikTok Live</a></li>
          <li><a href="/web-design#plans">Website plans</a></li>
        </ul></div>
        <div><h4>Contact</h4><ul>
          <li><a href="mailto:${SITE.email}">${SITE.email}</a></li>
          <li><a href="https://www.tiktok.com/@${SITE.tiktok}" target="_blank" rel="noopener">TikTok @${SITE.tiktok}</a></li>
        </ul></div>
      </div>
      <div class="footer-bottom">&copy; ${new Date().getFullYear()} EDZ Solutions Corporation. All rights reserved.</div>
    </div>`;
  document.body.append(footer);

  document.querySelectorAll("[data-tiktok]").forEach((a) => {
    a.href = `https://www.tiktok.com/@${SITE.tiktok}`;
    if (a.dataset.tiktok === "text") a.textContent = `@${SITE.tiktok}`;
  });
})();

// Generic JSON form helper used by inquiry forms.
async function postJSON(url, data) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
}

function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = `msg show ${ok ? "ok" : "err"}`;
}
