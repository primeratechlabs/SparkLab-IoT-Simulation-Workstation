#!/usr/bin/env bash
# Wait for the native clang+lld build, then run the ABI gate; on PASS, kick the WASM
# cross-build. Lets Stage-4 progress continue unattended.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build"
echo "[orchestrate] waiting for native clang+lld…"
for i in $(seq 1 180); do
  if [ -x "$B/native/bin/clang++" ] && [ -x "$B/native/bin/ld.lld" ]; then echo "[orchestrate] clang ready"; break; fi
  if grep -qiE "ninja: build stopped|FAILED:" "$B/native-build.log" 2>/dev/null; then echo "[orchestrate] NATIVE BUILD FAILED"; tail -15 "$B/native-build.log"; exit 1; fi
  sleep 60
done
[ -x "$B/native/bin/clang++" ] || { echo "[orchestrate] timed out waiting for clang"; exit 1; }

echo "[orchestrate] === running ABI gate ==="
bash "$HERE/abi-gate.sh"; ABI=$?
if [ $ABI -ne 0 ]; then echo "[orchestrate] ABI GATE did not pass (exit $ABI) — STOP, needs review"; exit $ABI; fi

echo "[orchestrate] === ABI gate passed → starting WASM cross-build (hours) ==="
bash "$HERE/build-llvm-wasm.sh"
echo "[orchestrate] DONE"
