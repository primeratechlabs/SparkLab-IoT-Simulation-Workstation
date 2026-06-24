# ESP32-C3 client-side toolchain + SDK pack — build recipe (Stage 4 `[CI/HUMAN]`)

> This is the **heavy toolchain build** Stage 4 depends on. It is a documented STOP
> point: building clang/LLVM → WASM needs **far more disk than the avr-gcc build**
> (LLVM source + build tree ≈ 40–80 GB; multi-hour). Do NOT run it until that disk is
> free. The toolchain-independent Stage 4 work is already done and unit-tested:
> `image-packer/esp32.ts` (elf2image / partition table / merge_bin), `build-orchestrator/
esp32-target.ts` (clang flags + `--start-group` link recipe), `peripheral-bridge/
esp32.ts` (C3 GPIO/ADC/LEDC conventions).

## Why ESP32-C3 is the lower-risk ESP target

- C3 is **32-bit RISC-V (rv32imc)** — an **in-tree LLVM/clang target** (no Xtensa fork,
  unlike ESP32/S2). `clang --target=riscv32-esp-elf -march=rv32imc` emits C3 objects.
- clang/LLVM → wasm is well-trodden (Emscripten _is_ clang; `binji/wasm-clang` runs
  clang+lld in the browser). lld supports RISC-V relocations natively.

## Part A — compiler: clang + lld → WASM

1. Clone LLVM (`llvm-project`); configure with emcc as the host compiler (Canadian
   cross, same shape as `build-avr-gcc.sh`):
   `-DLLVM_TARGETS_TO_BUILD="RISCV;WebAssembly" -DLLVM_ENABLE_PROJECTS="clang;lld"`
   `-DLLVM_DEFAULT_TARGET_TRIPLE=riscv32-esp-elf -DCMAKE_BUILD_TYPE=MinSizeRel`
   `-DLLVM_ENABLE_ZSTD=OFF` + the emcc single-file/MODULARIZE flags used for cc1plus.
2. Ship `clang.wasm` (or `cc1`/`cc1plus` equivalents) + `lld.wasm` as SINGLE*FILE ES
   modules, loaded the same way as the AVR tools (`real-toolchain.ts` blob-import).
   \_Alternative:* reuse a prebuilt `wasi-sdk` clang as the base and add the RISC-V
   target — avoids a full from-scratch LLVM build.

## Part B — SDK: arduino-esp32 + ESP-IDF (ESP32-C3) → SDK pack

1. Install ESP-IDF + arduino-esp32 for C3; extract the **precompiled core + esp-idf
   `.a` archives** (libesp32, libfreertos, libdriver, …), the **linker scripts**
   (`esp32c3.ld`, memory/sections), the **bootloader.bin**, and the C3 **headers**.
2. Build a **PCH** from `Arduino.h` to cut sketch parse time (Stage 4 §12).
3. Package as a signed/zstd pack (reuse `scripts/make-toolchain-fixtures.mjs` shape) →
   served like the AVR fixtures; consumed by the build worker.

## Part C — wire to the existing foundation

- Compile a sketch `.o` with `esp32CompileFlags()` (build-orchestrator).
- Link `.o` + SDK `.a` (in `--start-group/--end-group`, arduino-esp32 #4209) + linker
  scripts via `esp32LinkArgs()` → `firmware.elf`.
- `packEsp32(elf, bootloader, partitions)` (image-packer) → app image + partition table
  - merged flash (bootloader@0x1000, partition@0x8000, app@0x10000).
- Run via **simulation build profile** (API/HAL interception, §22) or qemu-wasm (C3) →
  GPIO/Serial observable through the Stage-3 kernel + `peripheral-bridge/esp32.ts`.

## ⚠ ABI GATE (Stage 4 gate #3 — strategic-core risk; STOP if it fails)

A **clang-built** sketch `.o` must link **cleanly** with the SDK `.a` (which may be
**gcc-built**) and the firmware must run correctly. If the calling convention / name
mangling / libcall ABI diverges:

1. add/adjust clang ABI flags (`-mabi=ilp32`, `-fshort-enums` parity, …); or
2. rebuild the SDK core with clang (`IDF_TOOLCHAIN=clang`, supported since IDF v5.0); or
3. fall back to a gcc-RISC-V frontend → wasm for the sketch too.
   Gate fixture: a C3 `Blink.ino` (clang) + SDK (gcc) → flash image → sim → GPIO toggles
   == reference. **Report the link log + pick a path before committing.**

## Estimates

- Disk: ~40–80 GB during the LLVM build (source ~3 GB, build tree the rest). Free that
  first (avr-gcc needed ~49 GB freed; LLVM needs more).
- Time: multiple hours for the LLVM→wasm build; SDK extraction ~30 min.
- Output pack: clang/lld wasm ~ tens of MB; SDK `.a` + scripts ~ tens of MB.
