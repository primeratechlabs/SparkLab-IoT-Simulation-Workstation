#!/usr/bin/env bash
# Build GNU binutils targeting AVR, compiled to WebAssembly via Emscripten.
# Proven pattern (wokwi/wasm-avr-gdb, racerxdl/riscv-online-asm). Yields the
# avr-ld / avr-objcopy / avr-ar the client linker needs (lld-AVR is incomplete).
set -euo pipefail

# Exported so EVERY (sub-)configure invoked during the build inherits it. libiberty
# is re-configured by `make`, so setting this only for the top configure isn't
# enough — without it, libiberty redefines psignal → "conflicting types" under musl.
export ac_cv_func_psignal=yes

cd /build
wget -q "https://ftp.gnu.org/gnu/binutils/binutils-${BINUTILS_VERSION}.tar.xz"
tar xf "binutils-${BINUTILS_VERSION}.tar.xz"
cd "binutils-${BINUTILS_VERSION}"

# emconfigure makes ./configure use emcc/em++. CRITICAL: --host tells configure we
# cross-compile to a wasm HOST (binutils RUNS on wasm), so it won't try to execute
# compiled test programs. --target=avr is what binutils GENERATES code for.
#
# ac_cv_func_psignal=yes: emscripten/musl declares psignal(int,const char*); without
# this override libiberty redefines its own psignal → "conflicting types" build error.
ac_cv_func_psignal=yes \
emconfigure ./configure \
  --host=wasm32-unknown-emscripten \
  --target="${AVR_TARGET}" \
  --prefix="${PREFIX}" \
  --disable-nls --disable-werror --disable-gdb --disable-sim --disable-gprofng \
  --with-static-standard-libraries

# JS-driver-ready ES module factory (callMain + FS, no auto-run) so the browser
# toolchain-loader can pipe files through avr-as/ld/objcopy. SINGLE_FILE embeds the
# wasm (binutils install drops sidecars). EXIT_RUNTIME=0 keeps the FS readable.
emmake make -j"$(nproc)" CFLAGS="-O2" \
  LDFLAGS="-sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createModule -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 -sSINGLE_FILE=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS"
emmake make install

# Collect the wasm + JS glue for the tools we ship.
mkdir -p "$OUT/binutils"
for tool in as ld objcopy ar; do
  cp "${PREFIX}/bin/${AVR_TARGET}-${tool}"* "$OUT/binutils/" 2>/dev/null || \
    echo "WARN: ${AVR_TARGET}-${tool} not found (check emscripten output naming)"
done
# Linker scripts (avr5.x, avr5.xn, …): avr-ld opens these at runtime from its
# scriptdir. We collect them so the driver can preload them into MEMFS.
cp -r "${PREFIX}/${AVR_TARGET}/lib/ldscripts" "$OUT/binutils/ldscripts" 2>/dev/null \
  || echo "WARN: ldscripts not found at ${PREFIX}/${AVR_TARGET}/lib/ldscripts"
echo "avr-binutils → wasm complete: $(ls "$OUT/binutils")"
