# EDZ Solutions

Business site: web design portfolio + inquiries, laser engraving catalog, AI metal business card designer (Claude) with Stripe checkout, TikTok Live schedule, and a password-protected orders page.

## Run locally
    brew services start postgresql@16 && createdb edz   # first time only
    ./run-local.sh                                      # http://localhost:3077

`run-local.sh` reads keys from `~/.config/edz/` (anthropic_key, stripe_key, admin_password, optional smtp.env). See `.env.example` for every setting.

## How orders flow
1. Customer designs a card and starts checkout → order saved as `pending_payment` with the design.
2. Stripe payment completes → the webhook (`/api/stripe-webhook`) or the thank-you page marks it `paid` (only once) and emails the alert with the design attached (SVG sized 3.5 × 2 in).
3. `/admin` lists paid orders: To engrave → Live queue → Ready to ship → Shipped. Download the design for the laser and mark progress.

## Where to edit
- `config/catalog.js` — card thickness / finish / quantity pricing (placeholders)
- `public/js/portfolio.js` — websites shown in the portfolio
- `public/js/site.js` — TikTok handle and contact email
- `public/live.html` — live schedule
- `brand/` — logo files (icon, wide logo, Stripe logo)
