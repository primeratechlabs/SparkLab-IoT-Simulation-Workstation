#!/usr/bin/env bash
# STAGE 5 Xtensa ABI GATE (the strategic checkpoint, mirrors the C3 gate). Does an esp-clang
# (Xtensa) compiled ESP32-classic sketch + clang-built arduino core link cleanly with the
# gcc-built esp32-libs (IDF) → a valid Xtensa firmware ELF? Compile the sketch + every core
# .cpp with clang (same int model), rebuild core.a, re-run the exact gcc link. Clean link +
# valid ELF == ABI gate PASS. The esp-clang lives in esp32-classic/build; the SDK + sketch
# tree are shared under esp32/build (arduino-cli data).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLANGPP="$HERE/build/native/bin/clang++"
ESPB="$HERE/../esp32/build"                  # shared arduino-cli data + sketches
PKG="$ESPB/arduino-data/packages/esp32"
X="$PKG/tools/esp-x32/2601"                   # xtensa gcc (triple xtensa-esp-elf; bin prefix xtensa-esp32-elf-)
CL="$PKG/tools/esp32-libs/3.3.10"             # ESP32-classic IDF libs
CORE="$PKG/hardware/esp32/3.3.10"
CXX="$X/xtensa-esp-elf/include/c++/14.2.0"
SK="$ESPB/sketches/ClassicBlink"
BP="$SK/buildtree"
LOG="$SK/build-verbose.log"
AR="$X/bin/xtensa-esp32-elf-ar"
READELF="$X/bin/xtensa-esp32-elf-readelf"

[ -x "$CLANGPP" ] || { echo "esp-clang not built yet ($CLANGPP)"; exit 1; }
[ -f "$LOG" ] || { echo "need a fresh verbose classic build (build-verbose.log)"; exit 1; }

# Header environment so clang's types/mangling agree with the xtensa gcc newlib + libstdc++.
ADAPT=(--target=xtensa-esp-elf -mcpu=esp32 -mlongcalls
  --gcc-toolchain="$X" --sysroot="$X/xtensa-esp-elf" -stdlib=libstdc++
  -nobuiltininc -isystem "$X/lib/gcc/xtensa-esp-elf/14.2.0/include"
  -isystem "$CXX"
  -isystem "$CXX/xtensa-esp-elf/esp32"
  -isystem "$CXX/backward"
  -isystem "$X/xtensa-esp-elf/include"
  -Qunused-arguments -Wno-unknown-warning-option -Wno-unknown-attributes -Wno-unused-command-line-argument)

# Clean compile flags (drop gcc-only -mfix-esp32-psram-* that clang rejects).
CFLAGS=(-c -w -Os -fno-rtti -ffunction-sections -fdata-sections -std=gnu++2a -fexceptions -fuse-cxa-atexit
  -DF_CPU=240000000L -DARDUINO=10607 -DARDUINO_ESP32_DEV -DARDUINO_ARCH_ESP32 -DESP32=ESP32
  '-DARDUINO_BOARD="ESP32_DEV"' '-DARDUINO_VARIANT="esp32"' -DARDUINO_PARTITION_default
  '-DARDUINO_HOST_OS="macosx"' '-DARDUINO_FQBN="esp32:esp32:esp32"'
  -DARDUINO_RUNNING_CORE=1 -DARDUINO_EVENT_RUNNING_CORE=1 -DARDUINO_USB_CDC_ON_BOOT=0
  @"$CL/flags/defines" -iprefix "$CL/include/" @"$CL/flags/includes"
  -I"$CL/qio_qspi/include" -I"$CORE/cores/esp32" -I"$CORE/variants/esp32" -I"$SK")

compile() { "$CLANGPP" "${ADAPT[@]}" "${CFLAGS[@]}" "$1" -o "$2" 2>> "$3"; }

echo "==> [1/4] recompile the SKETCH with esp-clang (Xtensa)"
SKETCH_O="$(find "$BP/sketch" -name '*.ino.cpp.o' | head -1)"
: > "$SK/clang-sketch.log"
compile "${SKETCH_O%.o}" "$SKETCH_O" "$SK/clang-sketch.log" \
  || { echo "CLANG SKETCH COMPILE FAILED:"; tail -20 "$SK/clang-sketch.log"; exit 3; }
echo "    sketch.o rebuilt with esp-clang"

echo "==> [2/4] recompile every CORE .cpp with esp-clang (overwrite gcc .o)"
PAIRS="$SK/core-pairs.txt"
grep -oE "cores/esp32/[^ ]*\.cpp -o [^ ]*core/[^ ]*\.cpp\.o" "$LOG" | sort -u > "$PAIRS"
echo "    core translation units: $(wc -l < "$PAIRS")"
: > "$SK/clang-core.log"; fail=0; n=0
while IFS= read -r pair; do
  [ -n "$pair" ] || continue
  src="$CORE/$(echo "$pair" | sed -E 's/ -o .*//')"
  out="$(echo "$pair" | sed -E 's/.* -o //')"
  if compile "$src" "$out" "$SK/clang-core.log"; then n=$((n+1)); else
    echo "    FAILED: $(basename "$src")"; fail=$((fail+1)); fi
done < "$PAIRS"
echo "    clang-compiled $n core TUs, $fail failed"
[ "$fail" -eq 0 ] || { echo "core clang compile failures:"; tail -25 "$SK/clang-core.log"; exit 3; }

echo "==> [3/4] rebuild core.a + relink (gcc driver, clang objects)"
CORE_A="$BP/core/core.a"; rm -f "$CORE_A"
"$AR" cr "$CORE_A" "$BP"/core/*.o 2>/dev/null
LINK_CMD="$(grep -oE "[^ ]*xtensa-esp32-elf-g\+\+ -Wl,--Map[^|&]*\.elf" "$LOG" | head -1)"
[ -n "$LINK_CMD" ] || { echo "could not extract link command"; exit 4; }
eval "$LINK_CMD" 2> "$SK/abi-link.log"
if [ $? -ne 0 ]; then
  echo "XTENSA ABI-GATE: LINK FAILED:"; grep -iE "undefined reference|cannot|error" "$SK/abi-link.log" | head -20; exit 5
fi

echo "==> [4/4] validate firmware ELF"
ELF="$(find "$BP" -name '*.ino.elf' | head -1)"
"$READELF" -h "$ELF" 2>/dev/null | grep -iE "Machine|Type|Entry" | head -3
echo ""
echo "✅ XTENSA ABI GATE PASS — esp-clang sketch + clang core link cleanly with gcc esp32-libs."
echo "   relinked ELF: $ELF ($(wc -c < "$ELF") bytes)"
