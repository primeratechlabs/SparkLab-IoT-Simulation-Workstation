/**
 * ESP32-C3 build target — REFERENCE-SPEC Stage 4. The compile/link recipe a RISC-V
 * clang-WASM toolchain (Stage T) consumes to build a sketch against a prebuilt
 * arduino-esp32 SDK: "precompiled core + compile only the sketch" (sketch-only delta).
 * ESP32-C3 is a 32-bit RISC-V core. Every flag below is EMPIRICALLY VERIFIED against the
 * real arduino-esp32 3.3.10 SDK flags + the Stage 4 ABI gate (native clang 19.1.0).
 *
 * ── ABI GATE #3 RESULT (ci/toolchain-builder/esp32/abi-gate-clang-core.sh) ──────────────
 * clang↔gcc are BINARY-ABI compatible on riscv32 (relocations + calling convention link
 * cleanly). The ONE divergence: clang's `int32_t` == `int` (Itanium mangling 'j'), gcc's
 * == `long` ('m'), so C++ symbols whose signatures contain uint32_t mismatch by NAME
 * (e.g. HardwareSerial::begin). IDF libs are C (extern "C", no mangling) → unaffected.
 *   ⇒ The arduino C++ CORE must be CLANG-built (same int model as the client-side sketch).
 *     Then clang sketch + clang core + gcc IDF C libs link into a valid C3 firmware ELF.
 *   ⇒ The SDK pack ships a CLANG-built core.a; the IDF archives stay gcc-built.
 */

export interface Esp32Target {
  id: string;
  /** clang target triple. */
  triple: string;
  /** Full ISA string incl. zicsr_zifencei — picks the matching gcc multilib (verified). */
  march: string;
  mabi: string;
  chip: 'esp32-c3';
  /** Arduino-ESP32 + IDF defines every translation unit needs. */
  defines: string[];
  /** Flash offsets for merge_bin. C3 boots from 0x0 (NOT 0x1000 like ESP32-classic). */
  flashOffsets: { bootloader: number; partitions: number; app: number };
}

export const ESP32C3_TARGET: Esp32Target = {
  id: 'esp-clang-wasm@native-verified', // ABI gate passed with native clang 19.1.0; WASM port pending
  triple: 'riscv32-esp-elf',
  march: 'rv32imc_zicsr_zifencei', // matches the SDK multilib rv32imc_zicsr_zifencei/ilp32
  mabi: 'ilp32',
  chip: 'esp32-c3',
  defines: [
    '-DESP32=ESP32',
    '-DARDUINO_ARCH_ESP32',
    '-DARDUINO_ESP32C3_DEV',
    '-DCONFIG_IDF_TARGET_ESP32C3=1',
    '-DARDUINO=10607',
    '-DF_CPU=160000000L',
    '-DARDUINO_USB_MODE=1',
    '-DARDUINO_USB_CDC_ON_BOOT=0',
    '-DARDUINO_BOARD="ESP32C3_DEV"',
  ],
  flashOffsets: { bootloader: 0x0, partitions: 0x8000, app: 0x10000 },
};

/**
 * The header environment clang needs to compile against the arduino-esp32 SDK headers,
 * which are authored for gcc (picolibc/newlib + libstdc++). VERIFIED in the ABI gate:
 * without these, clang fails on `#include_next <stdio.h>` then `<algorithm>`. Paths are
 * resolved from the mounted SDK pack (gccRoot = the riscv32-esp-elf gcc tree). Crucially,
 * `-nobuiltininc` + gcc's own compiler-include makes clang use the SAME C headers as gcc;
 * `-stdlib=libstdc++` selects gcc's libstdc++ (there is no libc++ for this target).
 */
export function esp32SdkHeaderFlags(
  gccRoot: string,
  march = ESP32C3_TARGET.march,
  mabi = ESP32C3_TARGET.mabi,
): string[] {
  const multilib = `${march}/${mabi}`; // e.g. rv32imc_zicsr_zifencei/ilp32
  const sysroot = `${gccRoot}/riscv32-esp-elf`;
  const cxx = `${sysroot}/include/c++/14.2.0`;
  return [
    `--gcc-toolchain=${gccRoot}`,
    `--sysroot=${sysroot}`,
    '-stdlib=libstdc++',
    '-nobuiltininc',
    `-isystem${gccRoot}/lib/gcc/riscv32-esp-elf/14.2.0/include`,
    `-isystem${cxx}`,
    `-isystem${cxx}/riscv32-esp-elf/${multilib}`,
    `-isystem${cxx}/backward`,
    `-isystem${sysroot}/include`,
  ];
}

/**
 * Assemble the clang compile flags for a sketch translation unit. The SDK include
 * paths + the precompiled-header are supplied by the SDK pack; reproducible flags
 * (§11) are layered on by the orchestrator. Libs go in --start-group when linking
 * (arduino-esp32 PR #4209) — that is the linker's concern, not here. Flag values match
 * the SDK's own cpp_flags (-fexceptions/-fno-rtti/-std=gnu++2a, VERIFIED).
 */
export function esp32CompileFlags(
  target: Esp32Target = ESP32C3_TARGET,
  extra: string[] = [],
): string[] {
  return [
    `--target=${target.triple}`,
    `-march=${target.march}`,
    `-mabi=${target.mabi}`,
    '-std=gnu++2a',
    '-fexceptions', // arduino-esp32 C3 enables exceptions (SDK cpp_flags)
    '-fno-rtti',
    '-ffunction-sections',
    '-fdata-sections',
    '-Os',
    ...target.defines,
    ...extra,
  ];
}

/**
 * Linker recipe: prebuilt SDK archives MUST be wrapped in --start-group/--end-group
 * (cyclic deps across esp-idf libs) — the historical arduino-esp32 link bug. Linker
 * scripts + the app/rodata layout come from the SDK pack.
 */
export function esp32LinkArgs(objects: string[], sdkLibs: string[], ldScripts: string[]): string[] {
  return [
    ...ldScripts.flatMap((s) => ['-T', s]),
    '--gc-sections',
    ...objects,
    '--start-group',
    ...sdkLibs,
    '--end-group',
  ];
}
