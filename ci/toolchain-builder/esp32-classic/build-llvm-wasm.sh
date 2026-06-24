#!/usr/bin/env bash
# STAGE 5 Path A — cross-build esp-clang + lld → WASM (XTENSA target) using the native build's
# tablegen + the shared emscripten SDK. Mirrors the proven RISC-V cross-build; the only deltas
# are the Xtensa experimental target + the esp fork source. Run AFTER build-llvm-native.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build"
SRC="$B/llvm-project"          # espressif/llvm-project (Xtensa)
NATIVE="$B/native"             # native esp-clang (Xtensa tblgen)
EMSDK="$HERE/../esp32/build/emsdk"   # shared emsdk from the RISC-V build
OUT="$B/wasm-out"
mkdir -p "$OUT"

[ -x "$NATIVE/bin/llvm-tblgen" ] || { echo "native llvm-tblgen missing — run build-llvm-native.sh first"; exit 1; }
[ -f "$EMSDK/emsdk_env.sh" ] || { echo "shared emsdk missing at $EMSDK"; exit 1; }
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh"

# Stub __wait4_disabled (LLVM Program.cpp's subprocess wait, unused by integrated-cc1).
cp "$HERE/../esp32/wasm-stubs.c" "$B/wasm-stubs.c" 2>/dev/null || true
emcc -Os -c "$B/wasm-stubs.c" -o "$B/wasm-stubs.o"

EMFLAGS="-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sFORCE_FILESYSTEM=1 -sSINGLE_FILE=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS,setValue,getValue \
  -sNO_DISABLE_EXCEPTION_CATCHING"

echo "==> [1/3] configure esp-LLVM → wasm (Xtensa experimental, clang;lld, native tblgen)"
emcmake cmake -G Ninja -S "$SRC/llvm" -B "$B/wasm" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_TARGETS_TO_BUILD="" \
  -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD="Xtensa" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_DEFAULT_TARGET_TRIPLE="xtensa-esp-elf" \
  -DLLVM_TABLEGEN="$NATIVE/bin/llvm-tblgen" \
  -DCLANG_TABLEGEN="$NATIVE/bin/clang-tblgen" \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_ARCMT=OFF \
  -DLLVM_TARGET_ARCH=wasm32 \
  -DCMAKE_CXX_FLAGS="-Dwait4=__wait4_disabled" \
  -DCMAKE_EXE_LINKER_FLAGS="$EMFLAGS $B/wasm-stubs.o"

echo "==> [2/3] build clang + lld → wasm (heavy, RAM-hungry)"
ninja -C "$B/wasm" clang lld -j6

echo "==> [3/3] collect artifacts"
for t in clang lld; do
  f="$B/wasm/bin/$t.js"
  [ -f "$f" ] && cp -L "$f" "$OUT/$t.mjs" && echo "    $OUT/$t.mjs ($(wc -c < "$OUT/$t.mjs") bytes)"
done
echo "DONE. esp-clang+lld wasm (Xtensa) in $OUT"
