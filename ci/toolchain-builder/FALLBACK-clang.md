# Fallback: clang-AVR → WASM (if avr-gcc→wasm stays intractable)

If `build-avr-gcc.sh` cannot be made to build/run reliably under Emscripten,
switch the **compiler frontend** to clang while keeping everything else.

## Why this is lower-build-risk

- clang/LLVM → wasm is well-trodden (Emscripten _is_ clang; `binji/wasm-clang`
  runs clang+lld in the browser).
- AVR is an **in-tree LLVM target** — a wasm clang built with the AVR target can
  emit AVR objects.
- We still link with the **`avr-ld.wasm`** from `build-avr-binutils.sh` (lld-AVR
  relocation support is incomplete), and still use the gcc-built `core.a`/avr-libc.

## Steps

1. Build LLVM/clang → wasm with `LLVM_TARGETS_TO_BUILD="AVR;WebAssembly"` and
   `-DLLVM_ENABLE_PROJECTS=clang`, host-compiled by emcc (or via the wasi-sdk
   clang as a base). Ship `clang.wasm`.
2. Compile sketch/lib: `clang --target=avr-unknown-unknown -mmcu=atmega328p -Os
<reproducible flags> -c …` → AVR `.o`.
3. Link with `avr-ld.wasm` + `core.a` + avr-libc (unchanged).
4. `avr-objcopy.wasm -O ihex` → `.hex` (unchanged).

## MUST verify before shipping (the ABI gate, same shape as Stage 4)

A clang-built sketch object must **link cleanly** against the gcc-built `core.a`
and avr-libc, and the resulting firmware must run on avr8js identically. If the
calling convention / name mangling / `-mmcu` libcall ABI diverges, prefer the
gcc path or rebuild `core.a` with clang. Gate: `Blink.ino` (clang) + `core.a`
(gcc) → `.hex` → avr8js LED blink == reference.
