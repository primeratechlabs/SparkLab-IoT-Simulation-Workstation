#!/usr/bin/env bash
# Upload the built packages/app/dist/ to a VPS site root (e.g. an aaPanel site at
# /www/wwwroot/<domain>) over rsync+ssh. Build first with `pnpm build:deploy`.
#
#   VPS_HOST=root@1.2.3.4 VPS_PATH=/www/wwwroot/your-domain.com bash scripts/deploy-vps.sh
#
# Does NOT use --delete (so aaPanel's .user.ini and other site files are left alone); stale hashed
# assets are harmless (immutable-cached) and can be pruned manually if desired.
set -euo pipefail
cd "$(dirname "$0")/.."
DIST="packages/app/dist"
: "${VPS_HOST:?set VPS_HOST=user@host}"
: "${VPS_PATH:?set VPS_PATH=/www/wwwroot/<your-domain>}"

test -f "$DIST/index.html" || { echo "FATAL: no $DIST/index.html — run 'pnpm build:deploy' first"; exit 1; }
test -f "$DIST/toolchain/manifest.json" || { echo "FATAL: toolchain missing in $DIST — run 'pnpm build:deploy'"; exit 1; }

echo "→ rsync $DIST/ (incl. ~62MB toolchain) → $VPS_HOST:$VPS_PATH/"
rsync -az --info=progress2 --exclude='.user.ini' --exclude='.htaccess' "$DIST/" "$VPS_HOST:$VPS_PATH/"

echo ""
echo "✓ uploaded. Next:"
echo "  1) aaPanel → site → Config: paste deploy/aapanel-nginx.conf's location blocks (replace 'location / {}')."
echo "  2) aaPanel → site → SSL → Let's Encrypt + Force HTTPS (COEP needs https)."
echo "  3) reload nginx (aaPanel does it on save, or: ssh $VPS_HOST 'nginx -t && nginx -s reload')."
echo "  4) verify:  pnpm verify:deploy https://<your-domain>"
