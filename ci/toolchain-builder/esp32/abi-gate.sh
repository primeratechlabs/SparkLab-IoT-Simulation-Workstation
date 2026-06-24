#!/usr/bin/env bash
# ABI GATE (Stage 4 gate #3): does a CLANG-built ESP32-C3 sketch object link cleanly
# against the GCC-built arduino-esp32 core/SDK and produce a valid firmware ELF?
# Strategy: do a normal arduino-cli (gcc) build, recompile ONLY the sketch TU with our
# native clang (RISC-V), overwrite its .o, then re-run the exact gcc link. Clean link +
# valid ELF == ABI gate PASS. RISC-V follows the standard psABI, so clang↔gcc should mix.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build"
CLANGPP="$B/native/bin/clang++"
PKG="$B/arduino-data/packages/esp32"
C3="$PKG/tools/esp32c3-libs/3.3.10"
CORE="$PKG/hardware/esp32/3.3.10"
RV="$PKG/tools/esp-rv32/2601" # riscv32-esp-elf gcc toolchain (newlib sysroot + libs)
SK="$B/sketches/C3Blink"
BP="$SK/buildtree"
ACLI="$B/bin/arduino-cli"
export ARDUINO_DIRECTORIES_DATA="$B/arduino-data"
export ARDUINO_DIRECTORIES_USER="$B/arduino-user"

[ -x "$CLANGPP" ] || { echo "ABI-GATE: clang not built yet ($CLANGPP)"; exit 1; }

echo "==> [1/4] gcc baseline build (keep tree)"
rm -rf "$BP"
"$ACLI" compile --fqbn esp32:esp32:esp32c3 --build-path "$BP" "$SK" --verbose > "$SK/build2.log" 2>&1 || { echo "gcc build failed"; tail -5 "$SK/build2.log"; exit 2; }
SKETCH_O="$(find "$BP/sketch" -name '*.ino.cpp.o' | head -1)"
SKETCH_CPP="${SKETCH_O%.o}"
[ -f "$SKETCH_CPP" ] || { echo "sketch cpp not found"; exit 2; }
echo "    sketch TU: $SKETCH_CPP"

echo "==> [2/4] recompile the sketch TU with native clang (RISC-V, ilp32)"
"$CLANGPP" \
  --target=riscv32-esp-elf -march=rv32imc_zicsr_zifencei -mabi=ilp32 \
  --gcc-toolchain="$RV" --sysroot="$RV/riscv32-esp-elf" -stdlib=libstdc++ \
  -nobuiltininc -isystem "$RV/lib/gcc/riscv32-esp-elf/14.2.0/include" \
  -isystem "$RV/riscv32-esp-elf/include/c++/14.2.0" \
  -isystem "$RV/riscv32-esp-elf/include/c++/14.2.0/riscv32-esp-elf/rv32imc_zicsr_zifencei/ilp32" \
  -isystem "$RV/riscv32-esp-elf/include/c++/14.2.0/backward" \
  -isystem "$RV/riscv32-esp-elf/include" \
  -Qunused-arguments -Wno-unknown-warning-option -Wno-unknown-attributes \
  -c -Os -fno-rtti -ffunction-sections -fdata-sections -std=gnu++2a -fexceptions -fuse-cxa-atexit \
  -DF_CPU=160000000L -DARDUINO=10607 -DARDUINO_ESP32C3_DEV -DARDUINO_ARCH_ESP32 -DESP32=ESP32 \
  -DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=0 -DCORE_DEBUG_LEVEL=0 \
  @"$C3/flags/defines" \
  -iprefix "$C3/include/" @"$C3/flags/includes" \
  -I"$C3/qio_qspi/include" -I"$CORE/cores/esp32" -I"$CORE/variants/esp32c3" -I"$SK" \
  "$SKETCH_CPP" -o "$SKETCH_O" 2> "$SK/clang-compile.log"
if [ $? -ne 0 ]; then echo "CLANG COMPILE FAILED:"; tail -20 "$SK/clang-compile.log"; exit 3; fi
echo "    clang object:"; "$B/native/bin/llvm-readobj" -h "$SKETCH_O" 2>/dev/null | grep -iE "Machine|Class|OS/ABI" | head -3

echo "==> [3/4] re-run the GCC LINK with the clang-built sketch.o"
LINK_CMD="$(grep -oE "[^ ]*riscv32-esp-elf-g\+\+ -Wl,--Map[^|&]*\.elf" "$SK/build2.log" | head -1)"
[ -n "$LINK_CMD" ] || { echo "could not extract link command"; exit 4; }
eval "$LINK_CMD" 2> "$SK/abi-link.log"
if [ $? -ne 0 ]; then echo "ABI-GATE: LINK FAILED (clang object incompatible with gcc SDK):"; tail -25 "$SK/abi-link.log"; exit 5; fi

echo "==> [4/4] validate the relinked firmware ELF"
ELF="$(find "$BP" -name '*.ino.elf' | head -1)"
"$PKG/tools/esp-rv32/2601/bin/riscv32-esp-elf-readelf" -h "$ELF" 2>/dev/null | grep -iE "Machine|Type|Entry" | head -3
echo ""
echo "✅ ABI GATE PASS — clang-built ESP32-C3 sketch links cleanly with the gcc-built SDK."
echo "   relinked ELF: $ELF ($(wc -c < "$ELF") bytes)"
