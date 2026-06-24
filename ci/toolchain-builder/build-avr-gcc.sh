#!/usr/bin/env bash
# Build avr-gcc to WebAssembly (Canadian cross: build=x86_64, host=wasm32-emscripten,
# target=avr). We build ONLY the compilers (cc1/cc1plus); the toolchain-loader drives
# them directly (no fork/exec in wasm). Idempotent: caches sources, gmp/mpfr/mpc, and
# the gcc configure so re-runs (e.g. to re-link) are fast when /build is a volume.
#
# Lessons applied: --host=wasm32-unknown-emscripten, export ac_cv_func_psignal=yes,
# gmp/mpfr/mpc with --disable-assembly, -k to skip gcov/gcov-tool (need POSIX ftw),
# JS-driver emscripten flags (MODULARIZE/callMain/FS/EXIT_RUNTIME=0/SINGLE_FILE).
set -euo pipefail
export ac_cv_func_psignal=yes

DEPS=/opt/deps
HOST=wasm32-unknown-emscripten
EMFLAGS="-sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createModule \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 -sSINGLE_FILE=1 \
  -sEXPORTED_RUNTIME_METHODS=callMain,FS"
cd /build
fetch() { local d="${2}"; [ -d "$d" ] || { wget -qN "$1" && tar xf "$(basename "$1")"; }; }

# ---- GMP / MPFR / MPC for the wasm host (cached by install marker) ---------
fetch "https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz"   gmp-6.3.0
fetch "https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.1.tar.xz" mpfr-4.2.1
fetch "https://ftp.gnu.org/gnu/mpc/mpc-1.3.1.tar.gz"   mpc-1.3.1

if [ ! -f "$DEPS/lib/libgmp.a" ]; then echo "==> gmp"; ( cd gmp-6.3.0 && \
  emconfigure ./configure --host="$HOST" --prefix="$DEPS" --disable-assembly --enable-static --disable-shared && \
  emmake make -j"$(nproc)" && emmake make install ); fi
if [ ! -f "$DEPS/lib/libmpfr.a" ]; then echo "==> mpfr"; ( cd mpfr-4.2.1 && \
  emconfigure ./configure --host="$HOST" --prefix="$DEPS" --with-gmp="$DEPS" --enable-static --disable-shared && \
  emmake make -j"$(nproc)" && emmake make install ); fi
if [ ! -f "$DEPS/lib/libmpc.a" ]; then echo "==> mpc"; ( cd mpc-1.3.1 && \
  emconfigure ./configure --host="$HOST" --prefix="$DEPS" --with-gmp="$DEPS" --with-mpfr="$DEPS" --enable-static --disable-shared && \
  emmake make -j"$(nproc)" && emmake make install ); fi

# ---- avr-gcc compilers only -----------------------------------------------
fetch "https://ftp.gnu.org/gnu/gcc/gcc-${GCC_VERSION}/gcc-${GCC_VERSION}.tar.xz" "gcc-${GCC_VERSION}"
cd "gcc-${GCC_VERSION}"
mkdir -p build && cd build
if [ ! -f Makefile ]; then echo "==> configure gcc"; emconfigure ../configure \
  --host="$HOST" --target="${AVR_TARGET}" --prefix="${PREFIX}" \
  --enable-languages=c,c++ \
  --disable-nls --disable-libssp --disable-libada --disable-shared \
  --disable-threads --disable-libgomp --disable-libquadmath --disable-bootstrap \
  --without-headers --with-dwarf2 \
  --with-gmp="$DEPS" --with-mpfr="$DEPS" --with-mpc="$DEPS"; fi

echo "==> make cc1/cc1plus (all-gcc -k, skipping gcov-tool)"
emmake make -j"$(nproc)" all-gcc CFLAGS="-O2" CXXFLAGS="-O2" LDFLAGS="$EMFLAGS" -k || true

test -f gcc/cc1     || { echo "FATAL: cc1 did not build";     ls -la gcc/cc1*     2>/dev/null; exit 1; }
test -f gcc/cc1plus || { echo "FATAL: cc1plus did not build"; ls -la gcc/cc1plus* 2>/dev/null; exit 1; }

mkdir -p "$OUT/gcc"
cp gcc/cc1 "$OUT/gcc/cc1"
cp gcc/cc1plus "$OUT/gcc/cc1plus"
cp gcc/xgcc "$OUT/gcc/avr-gcc" 2>/dev/null || true
cp -r gcc/include "$OUT/gcc/include" 2>/dev/null || true
cp -r gcc/include-fixed "$OUT/gcc/include-fixed" 2>/dev/null || true
echo "avr-gcc → wasm complete: $(ls "$OUT/gcc")"
