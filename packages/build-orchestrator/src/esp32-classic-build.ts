/**
 * ESP32-classic (Xtensa LX6) sim-build-profile firmware build (Stage 5) — the portable,
 * root-parameterized version of the flow proven by
 * `packages/emulators/src/esp32-classic-sim-profile.test.ts`: compile the sketch UNCHANGED against
 * the arduino-esp32 (classic) SDK headers with the windowed-register option OFF (call0 ABI), compile
 * the SAME architecture-neutral Arduino HAL shim (freestanding), and link both — through the
 * `.literal`-before-`.text` script so Xtensa L32R resolves — into a flat firmware ELF the Xtensa
 * interpreter runs. 100% client-side (backend=0, invariant I8); identical recipe in Node + browser.
 *
 * `root` is the virtual MEMFS prefix the SDK pack is mounted under (the gate test uses the on-disk
 * build tree; the browser worker mounts the served pack at a fixed root). The flags resolve every SDK
 * path from it. Mirrors `esp32-c3-build.ts`; the architecture lives entirely in the flags here —
 * `WasmRiscvToolchain` is reused purely as a generic wasm clang/lld driver (mount files + run argv).
 */
import type { WasmRiscvToolchain, ToolInput } from '@sparklab/toolchain-loader';
import type { FirmwareLibrary } from './esp32-c3-build.js';
import { normalizeXtensaRelocs } from './xtensa-reloc-normalize.js';

const PKG_REL = 'arduino-data/packages/esp32';
// WINDOWED register ABI — the real ESP32 default (ENTRY/CALL{4,8,12}/RETW). The XtensaCpu interpreter
// implements the windowed register file, so sketch + runtime + the picolibc/libgcc archives (which ship
// windowed-only) are all one consistent ABI → real libc (String/sprintf/<math>/64-bit divide) links + runs.
const TARGET = ['--target=xtensa-esp-elf', '-mcpu=esp32'];

/** Resolve the three SDK sub-roots (gcc toolchain, esp32-classic libs, arduino core) under `root`. */
export function xtensaSdkPaths(root: string): { gcc: string; libs: string; core: string } {
  const pkg = `${root}/${PKG_REL}`;
  return {
    gcc: `${pkg}/tools/esp-x32/2601`,
    libs: `${pkg}/tools/esp32-libs/3.3.10`,
    core: `${pkg}/hardware/esp32/3.3.10`,
  };
}

/** clang argv for a sketch translation unit (target + gcc header env + arduino-esp32 SDK includes). */
export function xtensaSketchArgs(root: string): string[] {
  const { gcc, libs, core } = xtensaSdkPaths(root);
  const cxx = `${gcc}/xtensa-esp-elf/include/c++/14.2.0`;
  const headerEnv = [
    `--gcc-toolchain=${gcc}`,
    `--sysroot=${gcc}/xtensa-esp-elf`,
    '-stdlib=libstdc++',
    '-nobuiltininc',
    '-isystem',
    `${gcc}/lib/gcc/xtensa-esp-elf/14.2.0/include`,
    '-isystem',
    cxx,
    '-isystem',
    `${cxx}/xtensa-esp-elf/esp32`,
    '-isystem',
    `${cxx}/backward`,
    '-isystem',
    `${gcc}/xtensa-esp-elf/include`,
  ];
  return [
    ...TARGET,
    ...headerEnv,
    // -ffunction-sections/-fdata-sections give --gc-sections per-function granularity on the SKETCH (the
    // runtime already has them); without them classic firmware can't dead-strip unused sketch code, unlike
    // C3 (xtensa-core audit — flag parity). NOT adding -DARDUINO_USB_MODE (a C3/S2/S3 USB-CDC define that is
    // wrong for the classic ESP32, which has no native USB and serials over UART).
    '-Qunused-arguments',
    '-w',
    '-c',
    '-Os',
    '-fno-rtti',
    '-fno-exceptions',
    '-ffunction-sections',
    '-fdata-sections',
    '-std=gnu++2a',
    '-DF_CPU=240000000L',
    '-DARDUINO=10607',
    '-DARDUINO_ESP32_DEV',
    '-DARDUINO_ARCH_ESP32',
    '-DESP32=ESP32',
    '-DARDUINO_USB_CDC_ON_BOOT=0',
    '-DCORE_DEBUG_LEVEL=0',
    `@${libs}/flags/defines`,
    '-iprefix',
    `${libs}/include/`,
    `@${libs}/flags/includes`,
    `-I${libs}/qio_qspi/include`,
    `-I${core}/cores/esp32`,
    `-I${core}/variants/esp32`,
    // arduino-esp32 networking libraries (headers shipped in the WiFi SDK pack) so `#include <WiFi.h>` resolves.
    `-I${core}/libraries/WiFi/src`,
    `-I${core}/libraries/Network/src`,
    `-I${core}/libraries/NetworkClientSecure/src`,
    `-I${core}/libraries/FS/src`,
    `-I${root}/spark`, // Sparklab helper headers (SparkNet.h, SparkBlynk.h); harmless if absent
  ];
}

/** clang argv for the freestanding HAL shim (no SDK headers needed). */
export const XTENSA_RUNTIME_ARGS = [
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

/** ld.lld argv: link with the `.literal`-before-`.text` script (ENTRY=_start, base 0) for L32R. */
export const XTENSA_LINK_ARGS = ['-T', '/xtensa-flat.ld', '--gc-sections', '/sketch.o', '/rt.o'];

export interface XtensaBuildDiag {
  severity: 'error' | 'warning' | 'note';
  message: string;
}
export interface XtensaBuildResult {
  ok: boolean;
  elf?: Uint8Array;
  diagnostics: XtensaBuildDiag[];
}

/**
 * Compile + link a preprocessed ESP32-classic sketch + the HAL shim into a firmware ELF. The caller
 * supplies the SDK header pack (mounted at `root`), the HAL shim source, and the Xtensa flat linker
 * script. Reproducible (re-link → byte-identical).
 */
export async function buildEsp32ClassicFirmware(opts: {
  toolchain: WasmRiscvToolchain;
  sketchSource: string | Uint8Array;
  runtimeSource: Uint8Array;
  linkerScript: Uint8Array;
  sdk: ToolInput[];
  root: string;
  libraries?: FirmwareLibrary[];
  /** Standard-library archives (picolibc libc.a/libm.a + libgcc.a, esp32 multilib) linked in a group so
   *  a sketch/library using memcpy/malloc/new/std::vector/<math> resolves with its real implementation. */
  archives?: { path: string; bytes: Uint8Array }[];
}): Promise<XtensaBuildResult> {
  const {
    toolchain,
    sketchSource,
    runtimeSource,
    linkerScript,
    sdk,
    root,
    libraries = [],
    archives = [],
  } = opts;
  const errs = (ds: XtensaBuildDiag[]): XtensaBuildDiag[] =>
    ds.filter((d) => d.severity === 'error');
  const sketchArgs = [
    ...xtensaSketchArgs(root),
    ...libraries.flatMap((l) => ['-I', l.includePath]),
  ];

  const sk = await toolchain.compile({
    args: sketchArgs,
    sdk,
    sourcePath: '/sketch/app.cpp',
    sourceBytes: sketchSource,
  });
  if (sk.exitCode !== 0 || errs(sk.diagnostics).length)
    return { ok: false, diagnostics: sk.diagnostics };

  const rt = await toolchain.compile({
    args: XTENSA_RUNTIME_ARGS,
    sdk: [],
    sourcePath: '/rt.cpp',
    sourceBytes: runtimeSource,
  });
  if (rt.exitCode !== 0 || errs(rt.diagnostics).length)
    return { ok: false, diagnostics: rt.diagnostics };

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
  // Fold R_XTENSA_32 in-data addends into the RELA records so our generic ld.lld links GCC-compiled jump
  // tables (picolibc switch statements — vfprintf et al.) correctly. See xtensa-reloc-normalize.ts. Applied
  // to every link input; a no-op for relocations whose addend is already in the record (addend-0 data).
  for (const o of objs) normalizeXtensaRelocs(o.bytes);
  for (const a of archives) normalizeXtensaRelocs(a.bytes);
  // Standard-library archives in a group after the objects (members pulled on demand — no bloat otherwise).
  const group = archives.length
    ? ['--start-group', ...archives.map((a) => a.path), '--end-group']
    : [];
  const lk = await toolchain.link({
    args: ['-T', '/xtensa-flat.ld', '--gc-sections', ...objs.map((o) => o.path), ...group],
    inputs: [{ path: '/xtensa-flat.ld', bytes: linkerScript }, ...objs, ...archives],
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
