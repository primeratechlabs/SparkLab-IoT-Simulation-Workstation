#!/usr/bin/env bash
# Assemble the arduino-avr-core SDK pack from a locally-installed Arduino AVR
# toolchain (avr-gcc 7.3) — REFERENCE-SPEC Stage T / Stage 2.
#
# Produces $OUT_DIR with everything the WASM client linker needs to turn a sketch
# into runnable firmware:
#   lib/   crt<mcu>.o, libc.a, libm.a, libgcc.a, lib<mcu>.a, core.a (NO LTO)
#   headers/{core,variant,avr-libc,gcc}  include trees for cc1plus
#
# core.a is compiled WITHOUT -flto so the client link stays a plain
# object→ELF step (no LTO plugin needed in the browser). The gcc builtin headers
# come from OUR cc1 (14.2) so __has_builtin / stddef etc. match the compiler that
# will run in the browser; the avr-libc + Arduino headers are version-independent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARDUINO_DATA="${ARDUINO_DATA:-$REPO_ROOT/.tools/arduino15}"
MCU="${MCU:-atmega328p}"
MULTILIB="${MULTILIB:-avr5}"
FCPU="${FCPU:-16000000L}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/ci/toolchain-builder/out/arduino-avr-core}"
CC1_INCLUDE="${CC1_INCLUDE:-$REPO_ROOT/ci/toolchain-builder/out/gcc/include}"

die() { echo "ERROR: $*" >&2; exit 1; }

TC="$(find "$ARDUINO_DATA/packages/arduino/tools/avr-gcc" -maxdepth 1 -type d -name '7.3.0*' 2>/dev/null | head -1)"
[ -n "$TC" ] || die "Arduino avr-gcc 7.3 toolchain not found under $ARDUINO_DATA (run: arduino-cli core install arduino:avr)"
HW="$(find "$ARDUINO_DATA/packages/arduino/hardware/avr" -maxdepth 1 -type d -name '1.*' 2>/dev/null | sort | tail -1)"
[ -n "$HW" ] || die "Arduino AVR hardware core not found under $ARDUINO_DATA"

GCC="$TC/bin/avr-gcc"; GPP="$TC/bin/avr-g++"; AR="$TC/bin/avr-ar"
CORE_SRC="$HW/cores/arduino"; VARIANT="$HW/variants/standard"
echo "toolchain: $($GCC --version | head -1)"
echo "core:      $HW"

# ── core.a (no LTO) ─────────────────────────────────────────────────────────
COMMON_FLAGS=(
  "-mmcu=$MCU" "-DF_CPU=$FCPU" "-DARDUINO=10808" "-DARDUINO_AVR_UNO"
  "-DARDUINO_ARCH_AVR" "-Os" "-ffunction-sections" "-fdata-sections"
  "-I$CORE_SRC" "-I$VARIANT"
)
OBJ="$(mktemp -d)"; trap 'rm -rf "$OBJ"' EXIT
for f in "$CORE_SRC"/*.c; do
  "$GCC" "${COMMON_FLAGS[@]}" -std=gnu11 -c "$f" -o "$OBJ/$(basename "${f%.c}").o"
done
for f in "$CORE_SRC"/*.cpp; do
  "$GPP" "${COMMON_FLAGS[@]}" -std=gnu++11 -fno-exceptions -fno-threadsafe-statics \
    -c "$f" -o "$OBJ/$(basename "${f%.cpp}").o"
done
# Assembly sources (.S): the core ships hand-written asm — notably wiring_pulse.S, which DEFINES
# `countPulseASM` that wiring_pulse.c's pulseIn() calls. Skipping these left pulseIn() with an
# undefined reference at link time (curriculum HC-SR04 sketches use pulseIn). avr-gcc -c on a .S
# preprocesses + assembles. Without this loop core.a carries wiring_pulse.o with `U countPulseASM`.
for f in "$CORE_SRC"/*.S; do
  [ -e "$f" ] || continue
  # Keep the extension in the object name (wiring_pulse.S.o) so it does NOT clobber wiring_pulse.c's
  # wiring_pulse.o — the core ships BOTH (the .c has pulseIn(), the .S has countPulseASM); we need both.
  "$GCC" "${COMMON_FLAGS[@]}" -c "$f" -o "$OBJ/$(basename "$f").o"
done
NOBJ="$(find "$OBJ" -name '*.o' | wc -l | tr -d ' ')"
[ "$NOBJ" -gt 0 ] || die "no core objects compiled"

# ── assemble the pack ───────────────────────────────────────────────────────
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/lib/$MULTILIB" "$OUT_DIR/headers/core" "$OUT_DIR/headers/variant" \
         "$OUT_DIR/headers/avr-libc" "$OUT_DIR/headers/gcc"

"$AR" rcsD "$OUT_DIR/lib/core.a" "$OBJ"/*.o
cp "$TC/avr/lib/$MULTILIB/crt${MCU}.o" "$OUT_DIR/lib/crt${MCU}.o"
cp "$TC/avr/lib/$MULTILIB/"*.a "$OUT_DIR/lib/$MULTILIB/"
cp "$TC/lib/gcc/avr/"*/"$MULTILIB/libgcc.a" "$OUT_DIR/lib/$MULTILIB/libgcc.a"

cp "$CORE_SRC"/*.h "$OUT_DIR/headers/core/"
cp "$VARIANT"/pins_arduino.h "$OUT_DIR/headers/variant/"
cp -R "$TC/avr/include/." "$OUT_DIR/headers/avr-libc/"
[ -d "$CC1_INCLUDE" ] && cp -R "$CC1_INCLUDE/." "$OUT_DIR/headers/gcc/" || echo "WARN: cc1 builtin headers not found at $CC1_INCLUDE"

echo "arduino-avr-core assembled at $OUT_DIR:"
echo "  core.a: $(du -h "$OUT_DIR/lib/core.a" | cut -f1) ($NOBJ objects, no-LTO)"
echo "  libs:   $(ls "$OUT_DIR/lib/$MULTILIB"/*.a | wc -l | tr -d ' ') archives + crt"
echo "  headers: core/ variant/ avr-libc/ gcc/"
