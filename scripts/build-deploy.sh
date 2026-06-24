#!/usr/bin/env bash
# Canonical deploy build. Produces packages/app/dist/ with the bundled UI AND the 62MB client
# toolchain, then HARD-FAILS if the toolchain didn't ship (a plain `vite build` without fixtures
# yields a dist whose in-browser compiler 404s) and runs the self-host guard.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DIST="$ROOT/packages/app/dist"

echo "==> install (frozen lockfile)"
pnpm install --frozen-lockfile

echo "==> generate fixtures (sample pack + client toolchain, ~62MB)"
pnpm fixtures
pnpm toolchain-fixtures
# ESP32 client-side packs (C3 / Xtensa) — gitignored 6MB blobs, regenerated from the sim-runtime HAL
# source so a deploy ships the current cpp (e.g. the Blynk presence shim). Each soft-skips if its
# heavy toolchain (ci/toolchain-builder) is absent, so a non-ESP32 deploy still builds.
pnpm c3-fixtures
pnpm esp32-classic-fixtures

echo "==> build app"
pnpm --filter @sparklab/app build

# Assert EVERY selectable (non-wip) board's toolchain shipped, with a size floor. A board that is
# selectable in the UI but whose toolchain soft-skipped (its ci/toolchain-builder output was absent)
# would ship a green dist that 404s mid-compile — fail the build instead. Mirror the non-wip boards in
# packages/app/src/lib/boards.ts: arduino-uno (AVR) + esp32-devkit (Xtensa) are selectable; esp32-c3 is wip.
assert_toolchain() {
  local dir="$1" min="$2" probe="$3" label="$4"
  test -f "$DIST/$dir/$probe" || {
    echo "FATAL: $DIST/$dir/$probe missing — the $label compiler would 404 at runtime. Build its toolchain (ci/toolchain-builder) first."
    exit 1
  }
  local mb
  mb=$(du -sm "$DIST/$dir" | cut -f1)
  test "$mb" -ge "$min" || {
    echo "FATAL: dist/$dir is only ${mb}MB (< ${min}MB) — $label toolchain looks truncated/missing"
    exit 1
  }
  echo "    $label OK (${mb}MB)"
}
echo "==> assert every selectable board's toolchain shipped into dist/"
assert_toolchain "toolchain" 20 "manifest.json" "Arduino Uno (AVR)"
assert_toolchain "esp32-classic-toolchain" 40 "clang.mjs" "ESP32 classic (Xtensa)"

# ESP32-C3 is WIP-disabled in the UI (boards.ts wip flag), so loadC3Toolchain() can never fire — its
# ~125MB pack is dead weight (and extra GPL-clearance surface). Drop it from the shippable artifact.
# RE-INCLUDE this when the C3 board is un-wip'd in boards.ts (delete this block; it ships automatically).
if [ -d "$DIST/c3-toolchain" ]; then
  echo "==> drop dist/c3-toolchain (ESP32-C3 board is WIP-disabled → unreachable, ~$(du -sm "$DIST/c3-toolchain" | cut -f1)MB saved)"
  rm -rf "$DIST/c3-toolchain"
fi

echo "==> self-host + header-drift + no-CDN guards"
node packages/app/scripts/check-dist-selfhost.mjs
node packages/app/scripts/check-src-no-cdn.mjs
pnpm --filter @sparklab/app exec vitest run src/deploy-headers.test.ts

echo ""
echo "✓ deploy build ready → $DIST"
echo "  serve:   PORT=8080 node packages/app/server.mjs"
echo "  docker:  docker build -f deploy/Dockerfile -t sparklab . && docker run --rm -p 8080:80 sparklab"
echo "  verify:  node scripts/verify-deploy.mjs http://localhost:8080"
