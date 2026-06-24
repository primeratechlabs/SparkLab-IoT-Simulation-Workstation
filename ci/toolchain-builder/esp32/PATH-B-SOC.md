# Stage 4 — Path B: full firmware-backed ESP32-C3 (SoC emulation)

The **sim build profile** (§22, DONE) closes gate #1 by running the real compiled sketch on
the rv32imc core with an Arduino HAL shim (GPIO/Serial/Wire → MMIO). That is the doctrine's
API→HAL bridge. **Path B** is the deeper "truth engine": boot the **real, full firmware** (the
6 MB arduino-esp32 IDF app) on a complete C3 SoC, no HAL shim.

## Build half — PROVEN ✅

The client-side toolchain already produces the real firmware:

- WASM clang compiles `C3Blink.ino.cpp` → an object **byte-identical** to native clang 19.1.0.
- Relinked with the clang-built arduino core + gcc IDF libs → a **byte-identical 6 MB C3
  firmware ELF** (entry 0x403807ca), the same one a native arduino-esp32 build emits.
- `image-packer/esp32.ts` converts it to a flash image **byte-identical to esptool**.

So `compile → link → flash-image` of the _real_ firmware is client-side-correct. The only
caveat: the heavy **full-IDF link** (≈159 MB of IDF archives, 43 `-u` forced symbols, the
`esp32c3.*.ld` scripts, `--wrap`) was run via the gcc driver here; doing it through wasm
`ld.lld` is a resource-scale exercise (wasm lld already links RISC-V — see the sim profile),
not a correctness one.

## Run half — the remaining (large) work

Booting the 6 MB firmware needs a real ESP32-C3 SoC, not just the CPU. The rv32imc core
(`emulators/rv32.ts`, RV32I+M+C, MMIO bus) is the foundation; the SoC adds:

1. **Mask ROM** — load Espressif's published `esp32c3_rev*.elf` at the ROM window; the app
   calls ROM routines (`ets_printf`, `memcpy`, UART/SPI/MMU ROM funcs) resolved via the
   `*.rom.ld` symbol scripts already in the SDK.
2. **Cache MMU** — map the IROM/DROM cache windows (≈0x42000000 / 0x3C000000) → flash
   offsets, so instruction/data fetches from flash resolve.
3. **Interrupt controller** — the C3 interrupt matrix + RISC-V CLINT-style core for the
   systimer tick and UART/GPIO IRQs.
4. **System timer (systimer)** — drives the FreeRTOS tick.
5. **Peripherals the IDF boot touches** — UART0 (boot log + Serial), GPIO, RNG, eFuse, RTC
   clock/watchdog, SPI flash controller.
6. **FreeRTOS** then runs on top (IDF port): `call_start_cpu0` → system init → scheduler →
   `app_main` → Arduino `loopTask` → `setup()`/`loop()`.

### Approaches (pick at Path-B kickoff)

- **A. Port Espressif QEMU (esp32c3) → WASM** — most complete (boots unmodified firmware).
  Heavy: QEMU is large; the esp32c3 machine lives in Espressif's fork. `qemu-wasm` exists as
  a base. Best correctness, biggest lift. The stage-4 doc names `ktock/qemu-wasm` /
  `lcgamboa/qemu` here.
- **B. Minimal C3 SoC in TS on the rv32 core** — load ROM + model MMU + the peripherals
  above + the IDF boot path. More controllable, still multi-session; the hard part is exact
  ROM/peripheral behaviour the IDF init depends on.

**Recommendation:** Path B is a multi-session / [CI-HUMAN]-scale effort dominated by the SoC.
The sim profile already satisfies gate #1 end-to-end. Schedule Path B as its own arc; start
with approach A if a working `qemu-wasm` esp32c3 base is reachable, else B incrementally
(ROM + UART + systimer first → get the boot log; then the interrupt controller + FreeRTOS).
