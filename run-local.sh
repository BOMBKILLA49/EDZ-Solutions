#!/bin/bash
# Starts the site on this Mac using the keys saved in ~/.config/edz
cd "$(dirname "$0")"
export ANTHROPIC_API_KEY="$(cat ~/.config/edz/anthropic_key)"
export STRIPE_SECRET_KEY="$(cat ~/.config/edz/stripe_key)"
export ADMIN_PASSWORD="$(cat ~/.config/edz/admin_password)"
[ -f ~/.config/edz/smtp.env ] && set -a && source ~/.config/edz/smtp.env && set +a
[ -f ~/.config/edz/smtp_pass ] && export SMTP_PASS="$(cat ~/.config/edz/smtp_pass)"
export PORT="${PORT:-3077}" SITE_URL="${SITE_URL:-http://localhost:3077}"
exec node server.js
