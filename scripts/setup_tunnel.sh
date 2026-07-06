#!/usr/bin/env bash
set -euo pipefail
# PakOS — Cloudflare Tunnel setup. Idempotent; safe to re-run.
# Usage: scripts/setup_tunnel.sh [hostname]   (default: pakos.pak-labs.com)
# See docs/REMOTE.md for the Access policy step this script can NOT do for you.

HOSTNAME_FQDN="${1:-pakos.pak-labs.com}"
TUNNEL_NAME="pakos"
PAKOS_PORT="${PAKOS_PORT:-4180}"
CF_DIR="$HOME/.cloudflared"

say()  { printf '\033[36m[setup]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }

command -v brew >/dev/null || fail "Homebrew required (https://brew.sh)"

if ! command -v cloudflared >/dev/null; then
  say "installing cloudflared…"
  brew install cloudflared
fi

if [[ ! -f "$CF_DIR/cert.pem" ]]; then
  say "authorizing with Cloudflare — a browser will open; pick the pak-labs.com zone"
  cloudflared tunnel login
fi

if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  say "creating tunnel '$TUNNEL_NAME'…"
  cloudflared tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID="$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$2==n {print $1}')"
[[ -n "$TUNNEL_ID" ]] || fail "could not resolve tunnel id for '$TUNNEL_NAME'"

say "routing DNS $HOSTNAME_FQDN → tunnel $TUNNEL_NAME"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_FQDN" || true  # exists already ⇒ fine

CONFIG="$CF_DIR/config.yml"
if [[ -f "$CONFIG" ]] && ! grep -q "$HOSTNAME_FQDN" "$CONFIG"; then
  fail "$CONFIG exists but doesn't mention $HOSTNAME_FQDN — merge it by hand (docs/REMOTE.md)"
fi
say "writing $CONFIG"
cat > "$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CF_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME_FQDN
    service: http://127.0.0.1:$PAKOS_PORT
  - service: http_status:404
EOF

if ! sudo launchctl list 2>/dev/null | grep -q com.cloudflare.cloudflared; then
  say "installing launch daemon (needs sudo)…"
  sudo cloudflared service install
else
  say "cloudflared service already installed — restarting"
  sudo launchctl kickstart -k system/com.cloudflare.cloudflared
fi

say "done. NOW LOCK IT DOWN: add the Cloudflare Access policy (docs/REMOTE.md §Access policy)."
say "until that policy exists, https://$HOSTNAME_FQDN is publicly reachable."
