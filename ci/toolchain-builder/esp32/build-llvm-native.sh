#!/usr/bin/env bash
# Build NATIVE clang + lld with the RISC-V target (arm64, fast) to validate the ESP32-C3
# toolchain approach + the ABI gate BEFORE the heavy WASM cross-build. Pinned to a
# release tag for reproducibility (§11). Run from ci/toolchain-builder/esp32/build.
set -euo pipefail

LLVM_TAG="${LLVM_TAG:-llvmorg-19.1.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
SRC="$BUILD/llvm-project"
mkdir -p "$BUILD"
cd "$BUILD"

if [ ! -d "$SRC/.git" ]; then
  echo "==> [1/3] shallow-cloning $LLVM_TAG"
  git clone --depth 1 --branch "$LLVM_TAG" https://github.com/llvm/llvm-project.git "$SRC"
else
  echo "==> [1/3] llvm-project already cloned"
fi

echo "==> [2/3] configure native (RISCV;WebAssembly, clang;lld, Release)"
cmake -G Ninja -S "$SRC/llvm" -B "$BUILD/native" \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_TARGETS_TO_BUILD="RISCV;WebAssembly" \
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
# Cap parallel LINK jobs to avoid OOM during the big clang/lld links on 16GB.
cmake --build "$BUILD/native" --target clang lld -- -j8 -l8 || \
  ninja -C "$BUILD/native" -j6 clang lld

echo "==> DONE. Tools:"
ls -lh "$BUILD/native/bin/clang" "$BUILD/native/bin/ld.lld" 2>/dev/null || true
"$BUILD/native/bin/clang" --version | head -2
echo "RISC-V target check:"
"$BUILD/native/bin/clang" --print-targets 2>/dev/null | grep -i riscv || "$BUILD/native/bin/clang" -print-targets | grep -i riscv
