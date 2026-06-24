#!/usr/bin/env bash
# ABI GATE v2 (Stage 4 gate #3): v1 proved clang↔gcc are BINARY-ABI compatible on riscv32
# (relocations/calling-convention link), with ONE divergence: clang's int32_t == int (mangled
# 'j'), gcc's == long ('m'), so C++ symbols whose signatures contain uint32_t mismatch by NAME.
# IDF libs are C (extern "C", no mangling) so unaffected; only the arduino C++ CORE is.
# FIX UNDER TEST: compile the CORE with clang too (same int model as the client-side sketch) →
# core C++ symbols match the sketch's references → links. Validates the production path: ship a
# CLANG-built arduino core in the SDK pack. Uses a clean clang flag set (NOT gcc's raw response
# files, which carry gcc-only -f flags like -fstrict-volatile-bitfields).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build"
CLANGPP="$B/native/bin/clang++"
PKG="$B/arduino-data/packages/esp32"
C3="$PKG/tools/esp32c3-libs/3.3.10"
CORE="$PKG/hardware/esp32/3.3.10"
RV="$PKG/tools/esp-rv32/2601"
SK="$B/sketches/C3Blink"
BP="$SK/buildtree"
LOG="$SK/build2.log"

[ -x "$CLANGPP" ] || { echo "clang not built"; exit 1; }
[ -f "$LOG" ] || { echo "run abi-gate.sh first (need build2.log)"; exit 1; }

# Header environment that makes clang's types/mangling agree with gcc (esp newlib + libstdc++).
ADAPT=(--target=riscv32-esp-elf -march=rv32imc_zicsr_zifencei -mabi=ilp32
  --gcc-toolchain="$RV" --sysroot="$RV/riscv32-esp-elf" -stdlib=libstdc++
  -nobuiltininc -isystem "$RV/lib/gcc/riscv32-esp-elf/14.2.0/include"
  -isystem "$RV/riscv32-esp-elf/include/c++/14.2.0"
  -isystem "$RV/riscv32-esp-elf/include/c++/14.2.0/riscv32-esp-elf/rv32imc_zicsr_zifencei/ilp32"
  -isystem "$RV/riscv32-esp-elf/include/c++/14.2.0/backward"
  -isystem "$RV/riscv32-esp-elf/include"
  -Qunused-arguments -Wno-unknown-warning-option -Wno-unknown-attributes -Wno-unused-command-line-argument)

# Clean compile flags (mirror arduino's intent; drop gcc-only -f flags clang rejects).
CFLAGS=(-c -w -Os -fno-rtti -ffunction-sections -fdata-sections -std=gnu++2a -fexceptions -fuse-cxa-atexit
  -DF_CPU=160000000L -DARDUINO=10607 -DARDUINO_ESP32C3_DEV -DARDUINO_ARCH_ESP32 -DESP32=ESP32
  '-DARDUINO_BOARD="ESP32C3_DEV"' '-DARDUINO_VARIANT="esp32c3"' -DARDUINO_PARTITION_default
  '-DARDUINO_HOST_OS="macosx"' '-DARDUINO_FQBN="esp32:esp32:esp32c3"'
  -DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=0 -DCORE_DEBUG_LEVEL=0
  @"$C3/flags/defines" -iprefix "$C3/include/" @"$C3/flags/includes"
  -I"$C3/qio_qspi/include" -I"$CORE/cores/esp32" -I"$CORE/variants/esp32c3" -I"$SK")

compile() { # src out logfile
  "$CLANGPP" "${ADAPT[@]}" "${CFLAGS[@]}" "$1" -o "$2" 2>> "$3"
}

echo "==> [1/4] recompile the SKETCH with clang"
SKETCH_O="$(find "$BP/sketch" -name '*.ino.cpp.o' | head -1)"
: > "$SK/clang-sketch.log"
compile "${SKETCH_O%.o}" "$SKETCH_O" "$SK/clang-sketch.log" \
  || { echo "sketch clang compile failed"; tail -15 "$SK/clang-sketch.log"; exit 3; }
echo "    sketch.o rebuilt with clang"

echo "==> [2/4] recompile every CORE .cpp with clang (overwrite gcc .o)"
PAIRS="$SK/core-pairs.txt"
grep -oE "cores/esp32/[^ ]*\.cpp -o [^ ]*core/[^ ]*\.cpp\.o" "$LOG" | sort -u > "$PAIRS"
echo "    core translation units: $(wc -l < "$PAIRS")"
[ -s "$PAIRS" ] || { echo "no core compile commands found"; exit 2; }
: > "$SK/clang-core.log"
fail=0; n=0
while IFS= read -r pair; do
  [ -n "$pair" ] || continue
  src="$CORE/$(echo "$pair" | sed -E 's/ -o .*//')"
  out="$(echo "$pair" | sed -E 's/.* -o //')"
  if compile "$src" "$out" "$SK/clang-core.log"; then n=$((n+1)); else
    echo "    FAILED: $(basename "$src")"; fail=$((fail+1)); fi
done < "$PAIRS"
echo "    clang-compiled $n core TUs, $fail failed"
[ "$fail" -eq 0 ] || { echo "core clang compile had failures:"; tail -25 "$SK/clang-core.log"; exit 3; }

echo "==> [3/4] rebuild core.a + relink (gcc driver, clang objects)"
CORE_A="$BP/core/core.a"; rm -f "$CORE_A"
# Archive ALL core objects: clang-rebuilt .cpp.o (matching int model) + gcc .c.o/.S.o
# (C/asm have no C++ mangling, so the int32 divergence doesn't apply to them).
"$RV/bin/riscv32-esp-elf-ar" cr "$CORE_A" "$BP"/core/*.o 2>/dev/null
LINK_CMD="$(grep -oE "[^ ]*riscv32-esp-elf-g\+\+ -Wl,--Map[^|&]*\.elf" "$LOG" | head -1)"
[ -n "$LINK_CMD" ] || { echo "could not extract link command"; exit 4; }
eval "$LINK_CMD" 2> "$SK/abi-link2.log"
if [ $? -ne 0 ]; then
  echo "ABI-GATE v2: LINK FAILED:"; grep -iE "undefined reference|cannot|error" "$SK/abi-link2.log" | head -20; exit 5
fi

echo "==> [4/4] validate firmware ELF"
ELF="$(find "$BP" -name '*.ino.elf' | head -1)"
"$RV/bin/riscv32-esp-elf-readelf" -h "$ELF" 2>/dev/null | grep -iE "Machine|Type|Entry" | head -3
echo ""
echo "✅ ABI GATE v2 PASS — clang sketch + clang CORE link cleanly with gcc IDF libs."
echo "   relinked ELF: $ELF ($(wc -c < "$ELF") bytes)"
echo "   => production path confirmed: ship a clang-built arduino core in the SDK pack."
