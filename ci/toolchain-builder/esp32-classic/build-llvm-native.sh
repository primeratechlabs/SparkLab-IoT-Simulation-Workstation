#!/usr/bin/env bash
# STAGE 5 Path A — build NATIVE clang + lld with the XTENSA target from Espressif's LLVM
# fork (Xtensa is NOT upstream; espressif/llvm-project maintains it). arm64, fast, to
# validate the ESP32-classic toolchain + run the Xtensa ABI gate BEFORE the heavy WASM
# cross-build. Pinned to an esp-19.1.2 tag (matches the RISC-V LLVM 19.1.0 build process).
set -euo pipefail

LLVM_TAG="${LLVM_TAG:-esp-19.1.2_20250312}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
SRC="$BUILD/llvm-project"
mkdir -p "$BUILD"
cd "$BUILD"

if [ ! -d "$SRC/.git" ]; then
  echo "==> [1/3] shallow-cloning espressif/llvm-project @ $LLVM_TAG"
  git clone --depth 1 --branch "$LLVM_TAG" https://github.com/espressif/llvm-project.git "$SRC"
else
  echo "==> [1/3] esp llvm-project already cloned"
fi

echo "==> [2/3] configure native (Xtensa, clang;lld, Release)"
cmake -G Ninja -S "$SRC/llvm" -B "$BUILD/native" \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_TARGETS_TO_BUILD="" \
  -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD="Xtensa" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_ENABLE_ARCMT=OFF

echo "==> [3/3] build clang + lld (link jobs capped for 16GB RAM)"
cmake --build "$BUILD/native" --target clang lld -- -j8 -l8 || \
  ninja -C "$BUILD/native" -j6 clang lld

echo "==> DONE. Tools:"
ls -lh "$BUILD/native/bin/clang" "$BUILD/native/bin/ld.lld" 2>/dev/null || true
"$BUILD/native/bin/clang" --version | head -2
echo "Xtensa target check:"
"$BUILD/native/bin/clang" -print-targets 2>/dev/null | grep -i xtensa || echo "NO XTENSA TARGET (!!)"
