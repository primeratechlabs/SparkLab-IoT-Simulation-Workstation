#!/usr/bin/env bash
# Orchestrates the AVR→WASM toolchain build. Fails fast; logs each phase.
set -euo pipefail

mkdir -p "$OUT"
echo "==> [1/3] avr-binutils → WASM (proven path)"
/build/build-avr-binutils.sh

echo "==> [2/3] avr-gcc → WASM (high-risk Canadian cross)"
/build/build-avr-gcc.sh

echo "==> [3/3] avr-libc + ArduinoCore-avr → core.a (host avr-gcc, Arduino ABI)"
/build/build-core-a.sh

echo "==> Done. Artifacts in $OUT:"
ls -lh "$OUT"
