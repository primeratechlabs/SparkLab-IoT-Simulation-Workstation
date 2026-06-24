# AVR Toolchain → WASM builder (Stage T, `[CI/HUMAN]`)

Produces the **AVR toolchain pack** that the browser uses to compile Arduino Uno
sketches **100% client-side** (invariant I8: no backend compile). The build runs
**once** on a server/CI; the output is a set of `.wasm` binaries the browser
downloads into OPFS and reuses (Stage 0 pack manager).

> **Where compilation happens:** this recipe _builds the compiler_. The compiler
> itself (`avr-gcc.wasm`, `avr-ld.wasm`, …) runs **in the user's browser**. The
> server never compiles user sketches.

## Outputs (content-addressed + Ed25519-signed packs)

| Pack                                         | Contents                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `avr-gcc-wasm-{threaded,singlethread}@<ver>` | `avr-gcc.wasm`, `cc1.wasm`/`cc1plus.wasm`, `avr-ld.wasm`, `avr-objcopy.wasm`, `avr-ar.wasm` + JS glue |
| `arduino-avr-core@<ver>`                     | prebuilt `core.a`, avr-libc (`libc.a`, `libm.a`, device specs), headers, `pins_arduino.h`             |

Pack layout matches `packages/pack-manager` (`manifest.json` + `files/<path>.zst`,
sha256 per file, signed). See `pack.mjs`.

## Resource requirements (report-back for the session machine)

| Resource  |                                                                          Need |
| --------- | ----------------------------------------------------------------------------: |
| Free disk |                       **~25–30 GB** (gcc Canadian-cross build tree dominates) |
| RAM       |                                                     8 GB+ (16 GB comfortable) |
| Time      | binutils ~15–30 min · **avr-gcc ~1.5–3 h** · avr-libc ~10 min · core.a ~2 min |
| Docker    |                                     required (emscripten/emsdk image ~3–4 GB) |

The Sparklab dev session machine had only **8.3 GB free** → insufficient. Run this
on a server/CI with the disk above, or free space locally and re-launch.

## How to run

```bash
cd ci/toolchain-builder
# 1. Build the emscripten toolchain image (pins emsdk + tool source versions).
docker build -t sparklab/avr-wasm-builder .
# 2. Run the build; artifacts land in ./out (host bind mount).
docker run --rm -v "$PWD/out:/out" sparklab/avr-wasm-builder
# 3. Assemble + sign packs (needs Node + a signing key; reuses the Stage 0 format).
SIGNING_KEY=./keys/avr-toolchain.private node pack.mjs ./out
```

## Build strategy (REFERENCE-SPEC §6 / Stage T)

1. **avr-binutils → WASM** (`build-avr-binutils.sh`) — **proven pattern**
   (`emconfigure ./configure --target=avr`, same as `wokwi/wasm-avr-gdb` and
   `riscv-online-asm`). Yields `avr-ld`, `avr-objcopy`, `avr-ar`. Low risk.
2. **avr-gcc → WASM** (`build-avr-gcc.sh`) — **highest-risk step**. GCC is a
   Canadian cross (host=wasm32, target=avr); needs gmp/mpfr/mpc built for the
   wasm host and emscripten patches for `fork`/process spawning. If this proves
   intractable, switch to the **clang-AVR fallback** (see `FALLBACK-clang.md`):
   LLVM/clang → wasm (well-trodden) with the AVR target enabled, linked by the
   `avr-ld.wasm` from step 1. ABI is then verified against the gcc-built `core.a`
   (Stage 4-style ABI gate) before shipping.
3. **avr-libc + core.a** (`build-core-a.sh`) — built with the **host** avr-gcc
   (Arduino-standard artifacts), so the ABI matches a gcc-built sketch exactly.
   These are _data_ packs (not wasm), reused as-is by the client linker.
4. **Pack + sign** (`pack.mjs`) — content-address, zstd-compress, Ed25519-sign.

## Reproducibility (mandatory — §11)

All compiles (here and in the browser) use the same reproducible-build flags
(`-ffile-prefix-map`, `-frandom-seed`, fixed `__DATE__/__TIME__`, `ar D`). This is
what lets a client-built object match a CI-built object byte-for-byte, enabling
the library-archive packs to act as a global build cache.

## Status

- [x] Recipe authored (this directory).
- [ ] Built (blocked on disk — see above).
- [ ] Validated: client compiles `Blink.ino` → `.hex` running on avr8js (Stage 2 gate #1).
- [ ] Reproducible: two builds → byte-identical (Stage T gate).
