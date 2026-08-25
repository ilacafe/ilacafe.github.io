#!/usr/bin/env bash
# Deploy the Café Ila Worker.
#
# Prompts for any secret that isn't set yet, generates RECAL_SECRET if missing,
# and deploys. Safe to re-run: secrets already set are left alone, so a second
# run is just `wrangler deploy`.
#
#   cd worker && ./deploy.sh

set -euo pipefail
cd "$(dirname "$0")"

say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
warn(){ printf '\033[33m%s\033[0m\n' "$*"; }

command -v npx >/dev/null || { echo "npx not found — install Node first."; exit 1; }

say "Checking you're logged in to Cloudflare"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

# ---------------------------------------------------------------- compatibility date
CURRENT=$(grep -E '^compatibility_date' wrangler.toml | cut -d'"' -f2)
if [ "$CURRENT" = "2025-01-01" ]; then
  warn ""
  warn "wrangler.toml still has the placeholder compatibility_date (2025-01-01)."
  warn "The live Worker's date is in the dashboard under:"
  warn "  Workers & Pages -> ila-push -> Settings -> Runtime"
  warn "Deploying with a different date can change runtime behaviour."
  read -rp "Enter the date shown there (or press Enter to keep $CURRENT): " D
  if [ -n "$D" ]; then
    sed -i.bak "s/^compatibility_date = .*/compatibility_date = \"$D\"/" wrangler.toml && rm -f wrangler.toml.bak
    echo "set to $D"
  fi
fi

# ---------------------------------------------------------------- secrets
# Read them out of the CURRENT Worker before this deploy overwrites it:
#   Workers & Pages -> ila-push -> Edit code -> the constants at the top.
EXISTING=$(npx wrangler secret list 2>/dev/null || echo '[]')
need(){ ! grep -q "\"$1\"" <<<"$EXISTING"; }

for S in VAPID_PRIVATE INGEST_SECRET ROBOT_PASSWORD ROBOT_EMAIL VAPID_SUBJECT EMAIL_FORWARD_TO; do
  if need "$S"; then
    say "$S is not set yet"
    echo "Copy it from the current Worker's source (dashboard -> ila-push -> Edit code)."
    read -rsp "  paste $S: " V; echo
    [ -z "$V" ] && { echo "empty — skipping, deploy will fail closed on this one"; continue; }
    printf '%s' "$V" | npx wrangler secret put "$S"
  else
    echo "ok  $S already set"
  fi
done

# RECAL_SECRET is new — it never existed in the old Worker, so generate it.
if need RECAL_SECRET; then
  R=$(openssl rand -hex 24)
  printf '%s' "$R" | npx wrangler secret put RECAL_SECRET
  say "RECAL_SECRET generated — save this, it's the only copy:"
  echo "  $R"
  echo "(it triggers a manual model refit; it must never appear in a page)"
else
  echo "ok  RECAL_SECRET already set"
fi

# ---------------------------------------------------------------- go
say "Deploying"
npx wrangler deploy

say "Done. The push relay now requires a staff Firebase token."
echo "Next: reload the tills and kitchen screens twice, and check the build"
echo "stamp at the foot of the page reads 2026-08-25.5."
