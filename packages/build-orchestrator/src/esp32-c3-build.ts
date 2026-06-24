/**
 * ESP32-C3 sim-build-profile firmware build (Stage 4) — the portable, root-parameterized version of
 * the flow proven by `packages/emulators/src/esp32c3-sim-profile.test.ts`: compile the sketch against
 * the arduino-esp32 SDK headers, compile the Arduino HAL shim (freestanding), and link both into a
 * flat `-Ttext=0` firmware ELF the rv32imc emulator runs. 100% client-side (backend=0, invariant I8).
 *
 * `root` is the virtual MEMFS prefix the SDK pack is mounted under (the gate test uses the on-disk
 * build tree; the browser worker mounts the served pack at a fixed root). The flags resolve every SDK
 * path from it, so the recipe is identical in Node and the browser.
 */
import type { WasmRiscvToolchain, ToolInput } from '@sparklab/toolchain-loader';

const PKG_REL = 'arduino-data/packages/esp32';
const TARGET = ['--target=riscv32-esp-elf', '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'];

/** Resolve the three SDK sub-roots (gcc toolchain, C3 IDF libs, arduino core) under `root`. */
export function c3SdkPaths(root: string): { gcc: string; c3: string; core: string } {
  const pkg = `${root}/${PKG_REL}`;
  return {
    gcc: `${pkg}/tools/esp-rv32/2601`,
    c3: `${pkg}/tools/esp32c3-libs/3.3.10`,
    core: `${pkg}/hardware/esp32/3.3.10`,
  };
}

/** clang argv for a sketch translation unit (target + gcc header env + arduino-esp32 SDK includes). */
export function c3SketchArgs(root: string): string[] {
  const { gcc, c3, core } = c3SdkPaths(root);
  const cxx = `${gcc}/riscv32-esp-elf/include/c++/14.2.0`;
  const headerEnv = [
    `--gcc-toolchain=${gcc}`,
    `--sysroot=${gcc}/riscv32-esp-elf`,
    '-stdlib=libstdc++',
    '-nobuiltininc',
    '-isystem',
    `${gcc}/lib/gcc/riscv32-esp-elf/14.2.0/include`,
    '-isystem',
    cxx,
    '-isystem',
    `${cxx}/riscv32-esp-elf/rv32imc_zicsr_zifencei/ilp32`,
    '-isystem',
    `${cxx}/backward`,
    '-isystem',
    `${gcc}/riscv32-esp-elf/include`,
  ];
  return [
    ...TARGET,
    ...headerEnv,
    '-Qunused-arguments',
    '-w',
    '-c',
    '-Os',
    '-fno-rtti',
    '-fno-exceptions',
    '-ffunction-sections',
    '-fdata-sections',
    '-std=gnu++2a',
    '-DF_CPU=160000000L',
    '-DARDUINO=10607',
    '-DARDUINO_ESP32C3_DEV',
    '-DARDUINO_ARCH_ESP32',
    '-DESP32=ESP32',
    '-DARDUINO_USB_MODE=1',
    '-DARDUINO_USB_CDC_ON_BOOT=0',
    '-DCORE_DEBUG_LEVEL=0',
    `@${c3}/flags/defines`,
    '-iprefix',
    `${c3}/include/`,
    `@${c3}/flags/includes`,
    `-I${c3}/qio_qspi/include`,
    `-I${core}/cores/esp32`,
    `-I${core}/variants/esp32c3`,
    // arduino-esp32 networking LIBRARIES (the headers shipped in the WiFi SDK pack) — without these
    // include paths `#include <WiFi.h>` doesn't resolve in the workspace even though the pack carries it.
    `-I${core}/libraries/WiFi/src`,
    `-I${core}/libraries/Network/src`,
    `-I${core}/libraries/NetworkClientSecure/src`,
    `-I${core}/libraries/FS/src`,
    `-I${root}/spark`, // Sparklab helper headers (SparkNet.h, SparkBlynk.h); harmless if absent
  ];
}

/** clang argv for the freestanding HAL shim (no SDK headers needed). */
export const C3_RUNTIME_ARGS = [
  ...TARGET,
  '-nostdlib',
  '-ffreestanding',
  '-ffunction-sections',
  '-fdata-sections',
  '-fno-exceptions',
  '-fno-rtti',
  '-std=gnu++2a',
  '-Os',
  '-c',
];

/** ld.lld argv: flat firmware at 0, entry `_start`, dead-strip. */
export const C3_LINK_ARGS = ['-Ttext=0', '-e', '_start', '--gc-sections', '/sketch.o', '/rt.o'];

export interface C3BuildDiag {
  severity: 'error' | 'warning' | 'note';
  message: string;
}
export interface C3BuildResult {
  ok: boolean;
  elf?: Uint8Array;
  diagnostics: C3BuildDiag[];
}

/**
 * Compile + link a preprocessed C3 sketch + the HAL shim into a firmware ELF. The caller supplies the
 * SDK header pack (mounted at `root`) and the HAL shim source. Reproducible (re-link → byte-identical).
 */
/** A user-uploaded library to compile + link alongside the sketch: its include dir (its headers must be
 *  mounted in `sdk`) + its source units. */
export interface FirmwareLibrary {
  includePath: string;
  sources: { path: string; bytes: Uint8Array; language: 'c' | 'c++' }[];
}

export async function buildC3Firmware(opts: {
  toolchain: WasmRiscvToolchain;
  sketchSource: string | Uint8Array;
  runtimeSource: Uint8Array;
  sdk: ToolInput[];
  root: string;
  libraries?: FirmwareLibrary[];
  /** Standard-library archives (picolibc libc.a/libm.a + libgcc.a) linked in a group so a sketch or
   *  library using memcpy/malloc/new/String/std::vector/<math> resolves with its REAL implementation.
   *  Archive members are pulled on demand, so a sketch that uses none keeps the firmware tiny. */
  archives?: { path: string; bytes: Uint8Array }[];
}): Promise<C3BuildResult> {
  const { toolchain, sketchSource, runtimeSource, sdk, root, libraries = [], archives = [] } = opts;
  const errs = (ds: C3BuildDiag[]): C3BuildDiag[] => ds.filter((d) => d.severity === 'error');
  // Each uploaded library's include dir is searched for the sketch + the library's own sources.
  const sketchArgs = [...c3SketchArgs(root), ...libraries.flatMap((l) => ['-I', l.includePath])];

  const sk = await toolchain.compile({
    args: sketchArgs,
    sdk,
    sourcePath: '/sketch/app.cpp',
    sourceBytes: sketchSource,
  });
  if (sk.exitCode !== 0 || errs(sk.diagnostics).length)
    return { ok: false, diagnostics: sk.diagnostics };

  const rt = await toolchain.compile({
    args: C3_RUNTIME_ARGS,
    sdk: [],
    sourcePath: '/rt.cpp',
    sourceBytes: runtimeSource,
  });
  if (rt.exitCode !== 0 || errs(rt.diagnostics).length)
    return { ok: false, diagnostics: rt.diagnostics };

  // Compile every uploaded-library source against the SDK + library include paths (clang picks C vs C++
  // from the source path's extension; -Qunused-arguments lets the C++ std flag pass for .c units).
  const libObjs: { path: string; bytes: Uint8Array }[] = [];
  for (const lib of libraries) {
    for (const src of lib.sources) {
      const o = await toolchain.compile({
        args: sketchArgs,
        sdk,
        sourcePath: src.path,
        sourceBytes: src.bytes,
      });
      if (o.exitCode !== 0 || errs(o.diagnostics).length)
        return { ok: false, diagnostics: o.diagnostics };
      libObjs.push({ path: `/lib${libObjs.length}.o`, bytes: o.object });
    }
  }

  const objs = [
    { path: '/sketch.o', bytes: sk.object },
    { path: '/rt.o', bytes: rt.object },
    ...libObjs,
  ];
  // Link the standard-library archives in a group AFTER the objects (lld resolves left-to-right; a group
  // handles the libc↔libgcc circular refs). Members are pulled only when referenced — no bloat otherwise.
  const group = archives.length
    ? ['--start-group', ...archives.map((a) => a.path), '--end-group']
    : [];
  const lk = await toolchain.link({
    args: ['-Ttext=0', '-e', '_start', '--gc-sections', ...objs.map((o) => o.path), ...group],
    inputs: [...objs, ...archives],
    outPath: '/fw.elf',
  });
  if (lk.exitCode !== 0 || errs(lk.diagnostics).length)
    return { ok: false, diagnostics: lk.diagnostics };

  return {
    ok: true,
    elf: lk.output,
    diagnostics: [...sk.diagnostics, ...rt.diagnostics, ...lk.diagnostics],
  };
}
