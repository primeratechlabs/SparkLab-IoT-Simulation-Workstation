#!/usr/bin/env bash
# Cross-build clang + lld → WASM (RISC-V target) using the NATIVE build's tablegen tools
# + emscripten. clang uses integrated-cc1 (runs the frontend in-process — no fork, which
# WASM can't do); lld runs as a separate module (the browser driver orchestrates, like
# the AVR cc1plus/avr-ld pattern). Run AFTER build-llvm-native.sh and install-emsdk.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build"
SRC="$B/llvm-project"
NATIVE="$B/native"
OUT="$B/wasm-out"
mkdir -p "$OUT"

[ -x "$NATIVE/bin/llvm-tblgen" ] || { echo "native llvm-tblgen missing — run build-llvm-native.sh first"; exit 1; }
# shellcheck disable=SC1091
source "$B/emsdk/emsdk_env.sh"

# Proven JS-driver flags (matches the AVR cc1plus build) + bigger memory/stack for clang.
# INITIAL_MEMORY=64MB: clang.wasm's static data is ~19MB, so the 16MB emscripten default is
# too small ("initial memory too small"). ALLOW_MEMORY_GROWTH still lets it grow to MAXIMUM.
EMFLAGS="-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sFORCE_FILESYSTEM=1 -sSINGLE_FILE=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS,setValue,getValue \
  -sNO_DISABLE_EXCEPTION_CATCHING"

echo "==> [1/3] configure LLVM → wasm (RISCV only, clang;lld, native tblgen)"
emcmake cmake -G Ninja -S "$SRC/llvm" -B "$B/wasm" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_TARGETS_TO_BUILD="RISCV" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_DEFAULT_TARGET_TRIPLE="riscv32-esp-elf" \
  -DLLVM_TABLEGEN="$NATIVE/bin/llvm-tblgen" \
  -DCLANG_TABLEGEN="$NATIVE/bin/clang-tblgen" \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_ARCMT=OFF \
  -DLLVM_TARGET_ARCH=wasm32 \
  -DCMAKE_CXX_FLAGS="-Dwait4=__wait4_disabled" \
  -DCMAKE_EXE_LINKER_FLAGS="$EMFLAGS $B/wasm-stubs.o"

echo "==> [2/3] build clang + lld → wasm (this is the heavy, RAM-hungry step)"
ninja -C "$B/wasm" clang lld -j6

echo "==> [3/3] collect artifacts"
# Emscripten emits <tool>.js (the ES6 module) + (with SINGLE_FILE) embeds the wasm. clang.js
# is a symlink to clang.js-NN; cp -L dereferences it to the real ~59MB module.
for t in clang lld; do
  f="$B/wasm/bin/$t.js"
  [ -f "$f" ] && cp -L "$f" "$OUT/$t.mjs" && echo "    $OUT/$t.mjs ($(wc -c < "$OUT/$t.mjs") bytes)"
done
echo "DONE. clang+lld wasm in $OUT"
