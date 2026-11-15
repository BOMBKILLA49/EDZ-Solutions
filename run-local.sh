#!/bin/bash
# Starts the site on this Mac using the keys saved in ~/.config/edz
cd "$(dirname "$0")"
export OPENAI_API_KEY="$(cat ~/.config/edz/openai_key)"
export STRIPE_SECRET_KEY="$(cat ~/.config/edz/stripe_key)"
export ADMIN_PASSWORD="$(cat ~/.config/edz/admin_password)"
[ -f ~/.config/edz/smtp.env ] && set -a && source ~/.config/edz/smtp.env && set +a
[ -f ~/.config/edz/smtp_pass ] && export SMTP_PASS="$(cat ~/.config/edz/smtp_pass)"
# Cold outreach mailbox (separate domain). Keys like OUTREACH_SMTP_HOST=..., see .env.example
[ -f ~/.config/edz/outreach.env ] && set -a && source ~/.config/edz/outreach.env && set +a
# Mailboxes: info@edzsolutions.site + the one saved in outreach2_user (passwords in ~/.config/edz)
export OUTREACH_MAILBOXES="$(node -e 'const fs=require("fs"),h=process.env.HOME+"/.config/edz/",r=(f)=>{try{return fs.readFileSync(h+f,"utf8").trim()}catch{return ""}};console.log(JSON.stringify([{user:"info@edzsolutions.site",pass:r("outreach_smtp_pass"),start:"2026-11-15"},{user:r("outreach2_user"),pass:r("outreach2_smtp_pass"),start:"2026-11-15"}].filter(m=>m.user&&m.pass)))')"
export PORT="${PORT:-3077}" SITE_URL="${SITE_URL:-http://localhost:3077}"
exec node server.js
