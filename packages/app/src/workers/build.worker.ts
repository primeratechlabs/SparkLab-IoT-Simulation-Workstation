/**
 * Build daemon worker (invariant I2) — hosts the long-lived BuildDaemonImpl over
 * real OPFS + SQLite-WASM index, exposed to the UI via Comlink. Stage 1 uses the
 * stub toolchain; the warm instance + content-addressed caches are real, so the
 * acceptance gate (warm reuse, object cache across reload, reproducibility) runs
 * against genuine browser storage.
 */

import * as Comlink from 'comlink';
import {
  openFs,
  openBuildIndex,
  bootstrapDirs,
  type VirtualFs,
  type BuildIndex,
} from '@sparklab/opfs';
import {
  BuildDaemonImpl,
  preprocessSketch,
  resolveLibraries,
  scanIncludeDirectives,
  buildC3Firmware,
  buildEsp32ClassicFirmware,
  type SdkConfig,
  type BuildOutcome,
  type ProjectSource,
  type LibraryCatalogEntry,
  type FirmwareLibrary,
} from '@sparklab/build-orchestrator';
import type { ToolInput } from '@sparklab/toolchain-loader';
import { BOARD_CATALOG } from '@sparklab/schematic';
import { loadRealRiscvToolchain, type RealRiscvToolchain } from '../lib/real-riscv-toolchain';
import { loadRealXtensaToolchain, type RealXtensaToolchain } from '../lib/real-xtensa-toolchain';
import type { Diagnostic } from '@sparklab/shared';
import { sha256 } from '@sparklab/shared';
import { hexImageFromText } from '@sparklab/image-packer';
import { loadRealToolchain, type RealToolchain } from '../lib/real-toolchain.js';
import { isBuiltInLibrary, type UserLibrary } from '../lib/arduino-library';
import {
  resolveLibraryClosure,
  closureNotes,
  type BoardArchitecture,
} from '../lib/library-resolver';

/** User-uploaded libraries (parsed .zips) the next build links if the sketch #includes them. Set via
 *  setUserLibraries before a build; mounted at /userlib/<name>. */
let userLibraries: UserLibrary[] = [];
const USERLIB_ROOT = '/userlib';
const userLibPath = (name: string): string => `${USERLIB_ROOT}/${name}`;
/** Libraries actually used by the build — those that don't duplicate a built-in shim (e.g. a real Blynk
 *  library is dropped; the simulator's HTTP Blynk is used via its compatible headers instead). */
const buildLibraries = (): UserLibrary[] =>
  userLibraries.filter((lib) => !isBuiltInLibrary(lib.provides));

/** For an ESP32 firmware build: the user libraries the sketch #includes → their headers (mounted in the
 *  SDK) + their source units to compile + link. Empty when the sketch uses no uploaded library. Also
 *  reports any uploaded library that the sketch uses but that is SUBSTITUTED by a built-in shim (Blynk /
 *  WiFi) — so the UI can disclose the swap at build time, not silently (transparency: no fake library use). */
function firmwareLibrariesFor(
  source: string,
  enc: TextEncoder,
  arch: BoardArchitecture,
): {
  sdkInputs: ToolInput[];
  libraries: FirmwareLibrary[];
  substituted: string[];
  closureNotes: string[];
} {
  const includes = new Set(scanIncludeDirectives(source).map((d) => d.name));
  const installed = buildLibraries();
  // Directly-#included libraries are the roots; pull in their transitive `depends` closure so a
  // dependency-of-a-dependency compiles even when the sketch only includes the top one (AUD-018).
  const roots = installed.filter((lib) => lib.provides.some((h) => includes.has(h)));
  const resolved = resolveLibraryClosure(roots, installed, arch);
  const used = resolved.closure;
  const substituted = userLibraries
    .filter((lib) => isBuiltInLibrary(lib.provides) && lib.provides.some((h) => includes.has(h)))
    .map((lib) => lib.name);
  const sdkInputs: ToolInput[] = used.flatMap((lib) =>
    lib.headers.map((h) => ({
      path: `${userLibPath(lib.name)}/${h.rel}`,
      bytes: enc.encode(h.content),
    })),
  );
  const libraries: FirmwareLibrary[] = used.map((lib) => ({
    includePath: userLibPath(lib.name),
    sources: lib.sources.map((s) => ({
      path: `${userLibPath(lib.name)}/${s.rel}`,
      bytes: enc.encode(s.content),
      language: s.language,
    })),
  }));
  return { sdkInputs, libraries, substituted, closureNotes: closureNotes(resolved) };
}

/**
 * The Arduino String class (cores/esp32/WString.cpp) ships in the SDK pack but — like the rest of the
 * core — is NOT pre-compiled, so a sketch using `String`/`String.toFloat()`/`.toInt()` fails to LINK
 * unless we compile it. Add it as an always-present core source. (toInt/toFloat call atol/atof, which the
 * runtime shim provides via the real sscanf — avoiding picolibc's strtod/strtol, whose errno needs a TLS
 * relocation our generic lld can't resolve.) Unused String code is dropped by --gc-sections, so sketches
 * that never touch String pay only compile time, not binary size. Returns [] for an older pack whose
 * manifest predates the WString.cpp entry (then String simply isn't available — fail-closed, not wrong).
 */
// Print overloads that take an Arduino String. The runtime shim declares its own minimal `Print` (with
// the SDK-matching mangled names) and so cannot see String's inline c_str(); this tiny unit is compiled
// WITH the SDK headers, so it sees the real String + Print and forwards to Print::print(const char*) —
// the symbol the shim defines. Lets `Serial.print(aString)` / `println(aString)` link. (`this` is never
// dereferenced; output goes to UART MMIO via the shim, exactly like the other Print overloads.)
const STRING_PRINT_BRIDGE =
  '#include <Arduino.h>\n' +
  'size_t Print::print(const String &s) { return print(s.c_str()); }\n' +
  'size_t Print::println(const String &s) { return println(s.c_str()); }\n';

function coreSourceLibraries(sdk: ToolInput[]): FirmwareLibrary[] {
  const ws = sdk.find((f) => f.path.endsWith('/cores/esp32/WString.cpp'));
  if (!ws) return [];
  const dir = ws.path.slice(0, ws.path.lastIndexOf('/'));
  const wsBytes = typeof ws.bytes === 'string' ? enc.encode(ws.bytes) : ws.bytes;
  return [
    {
      includePath: dir,
      sources: [
        { path: ws.path, bytes: wsBytes, language: 'c++' as const },
        {
          path: `${dir}/__sparklab_string_print.cpp`,
          bytes: enc.encode(STRING_PRINT_BRIDGE),
          language: 'c++' as const,
        },
      ],
    },
  ];
}

/** A user-facing note (Vietnamese) for each library the simulator substituted with its built-in shim. */
function substitutionNotes(names: string[]): string[] {
  return names.map(
    (name) =>
      `Thư viện "${name}" được thay bằng bản tích hợp sẵn của trình mô phỏng (Blynk/WiFi qua HTTP+MQTT/MMIO) vì trình duyệt không mở được TCP thô — hành vi được mô phỏng, không phải stack mạng nhị phân của thư viện gốc.`,
  );
}

const SDK: SdkConfig = {
  target: 'avr-atmega328p',
  sdkPackHash: 'sha256:sample-sdk',
  libraryPackHash: 'sha256:sample-libpack',
  boardId: 'uno',
  frameworkVersion: 'arduino-avr@1.8.6',
  toolchainPackHash: 'sha256:stub-toolchain',
};

const CORE_HEADER = '// Arduino core (sample)\n';
const SERVO_HEADER = '#include <Arduino.h>\n// Servo (sample)\n';

// Deterministic sample project sources (content fixed → reproducible).
const SAMPLE_MAIN = 'void setup(){}\nvoid loop(){}\n';
const SAMPLE_MAIN_EDITED = 'void setup(){}\nvoid loop(){ /* edited */ }\n';
const SAMPLE_UTIL = 'int helper(){ return 42; }\n';

const enc = new TextEncoder();

interface Ready {
  fs: VirtualFs;
  index: BuildIndex;
  daemon: BuildDaemonImpl;
  fsBackend: string;
  indexBackend: string;
}

let readyPromise: Promise<Ready> | null = null;

async function doInit(): Promise<Ready> {
  const fs = await openFs();
  const index = await openBuildIndex();
  for (const dir of bootstrapDirs()) await fs.mkdirp(dir);
  const daemon = new BuildDaemonImpl(fs, index);
  daemon.configureSdk(
    SDK,
    [
      { includePath: '/sdk/core', name: 'Arduino.h', bytes: enc.encode(CORE_HEADER) },
      { includePath: '/lib/Servo', name: 'Servo.h', bytes: enc.encode(SERVO_HEADER) },
    ],
    [
      {
        name: 'Servo',
        version: '1.2.0',
        includePath: '/lib/Servo',
        providesHeaders: ['Servo.h'],
        architectures: ['avr'],
      },
    ],
  );
  await daemon.start();
  return { fs, index, daemon, fsBackend: fs.backend, indexBackend: index.backend };
}

function ready(): Promise<Ready> {
  if (!readyPromise) readyPromise = doInit();
  return readyPromise;
}

const api = {
  async init(): Promise<{ fsBackend: string; indexBackend: string }> {
    const r = await ready();
    return { fsBackend: r.fsBackend, indexBackend: r.indexBackend };
  },

  async setupSampleProject(withServo = false): Promise<void> {
    const { daemon } = await ready();
    const main = withServo ? `#include <Servo.h>\n${SAMPLE_MAIN}` : SAMPLE_MAIN;
    daemon.setProject([
      { id: 'main.cpp', bytes: enc.encode(main) },
      { id: 'util.cpp', bytes: enc.encode(SAMPLE_UTIL) },
    ]);
  },

  async editMain(): Promise<void> {
    const { daemon } = await ready();
    daemon.upsertSource({ id: 'main.cpp', bytes: enc.encode(SAMPLE_MAIN_EDITED) });
  },

  async build(): Promise<BuildOutcome> {
    const { daemon } = await ready();
    return daemon.build();
  },

  async scanLibraries(): Promise<string[]> {
    const { daemon } = await ready();
    const graph = await daemon.scanDependencies();
    return graph.libraries.map((l) => l.name);
  },

  /**
   * Stage 2 Gate #1: compile a single Arduino sketch to Intel HEX 100% client-side.
   */
  async compileToHex(source: string): Promise<HexBuild> {
    return buildProject([{ name: 'sketch.ino', content: source }]);
  },

  /** Set the user-uploaded libraries available to subsequent builds (parsed from .zip on the main
   *  thread). Replaces the prior set; an empty array clears them. */
  setUserLibraries(libs: UserLibrary[]): void {
    userLibraries = libs;
  },

  /**
   * Multi-file build: .ino tabs are preprocessed + merged, .cpp/.c files compile as
   * units, and any #include'd preset library (Wire/Servo/LiquidCrystal_I2C, with
   * transitive deps) has its sources compiled + linked — all through the BuildDaemon
   * so library objects are content-cached and only edited units recompile.
   */
  async compileProject(files: ProjectFile[]): Promise<HexBuild> {
    return buildProject(files);
  },

  /**
   * Board-aware compile: Uno (AVR) → Intel HEX (avr-gcc); ESP32-C3 (RISC-V) and ESP32-classic
   * (Xtensa) → firmware ELF (clang+lld WASM + the architecture-neutral sim-profile HAL). 100%
   * client-side (I8) — the SoC backend is chosen by the board architecture, never a silent fallthrough.
   */
  async compileToImage(source: string, boardId: string): Promise<ImageResult> {
    // Unknown board → fail closed, never silently compile as AVR (AUD-006).
    const board = BOARD_CATALOG[boardId];
    if (!board)
      return {
        format: 'elf',
        error: `Board không hợp lệ: "${boardId}". Hãy chọn lại board hợp lệ.`,
      };
    const arch = board.architecture;
    if (arch === 'riscv32') {
      const { toolchain, sdk, runtimeSource, root, archives } = await loadC3Toolchain();
      const cpp = `#include <Arduino.h>\n${preprocessSketch([{ name: 'sketch.ino', content: source }]).cpp}`;
      const lib = firmwareLibrariesFor(source, encode, arch);
      const built = await buildC3Firmware({
        toolchain,
        sketchSource: cpp,
        runtimeSource,
        sdk: [...sdk, ...lib.sdkInputs],
        root,
        libraries: [...coreSourceLibraries(sdk), ...lib.libraries],
        archives,
      });
      if (!built.ok || !built.elf) {
        const err = built.diagnostics.find((d) => d.severity === 'error');
        return { format: 'elf', error: err ? err.message : 'Biên dịch ESP32-C3 thất bại' };
      }
      return {
        format: 'elf',
        elf: built.elf,
        notes: [...substitutionNotes(lib.substituted), ...lib.closureNotes],
      };
    }
    if (arch === 'xtensa') {
      const { toolchain, sdk, runtimeSource, linkerScript, root, archives } =
        await loadXtensaToolchain();
      const cpp = `#include <Arduino.h>\n${preprocessSketch([{ name: 'sketch.ino', content: source }]).cpp}`;
      const lib = firmwareLibrariesFor(source, encode, arch);
      const built = await buildEsp32ClassicFirmware({
        toolchain,
        sketchSource: cpp,
        runtimeSource,
        linkerScript,
        sdk: [...sdk, ...lib.sdkInputs],
        root,
        libraries: [...coreSourceLibraries(sdk), ...lib.libraries],
        archives,
      });
      if (!built.ok || !built.elf) {
        const err = built.diagnostics.find((d) => d.severity === 'error');
        return { format: 'elf', error: err ? err.message : 'Biên dịch ESP32 (Xtensa) thất bại' };
      }
      return {
        format: 'elf',
        elf: built.elf,
        notes: [...substitutionNotes(lib.substituted), ...lib.closureNotes],
      };
    }
    const hb = await buildProject([{ name: 'sketch.ino', content: source }]);
    if (hb.hex) return { format: 'intel-hex', hex: hb.hex };
    // Surface the real compiler error (linker/cc1plus message) instead of a generic string, so a failed
    // build is actionable in the UI + tests rather than an opaque "Biên dịch thất bại" (Issue 7).
    const err = hb.diagnostics.find((d) => d.severity === 'error');
    return {
      format: 'intel-hex',
      error: err ? `Biên dịch thất bại: ${err.message}` : 'Biên dịch thất bại',
    };
  },
};

export interface ImageResult {
  format: 'intel-hex' | 'elf';
  hex?: string;
  elf?: Uint8Array;
  error?: string;
  /** Non-fatal build notes (e.g. a library substituted by a built-in shim) — shown to the user. */
  notes?: string[];
}

// Warm C3 toolchain singleton — load the ~100MB clang+lld + SDK once, reuse across compiles.
let c3Promise: Promise<RealRiscvToolchain> | null = null;
function loadC3Toolchain(): Promise<RealRiscvToolchain> {
  return (c3Promise ??= loadRealRiscvToolchain());
}

// Warm Xtensa (ESP32-classic) toolchain singleton — same pattern, separate ~85MB clang+lld + SDK.
let xtensaPromise: Promise<RealXtensaToolchain> | null = null;
function loadXtensaToolchain(): Promise<RealXtensaToolchain> {
  return (xtensaPromise ??= loadRealXtensaToolchain());
}

// ── Real avr-gcc.wasm build path (dedicated daemon; shares OPFS fs/index) ─────────

export interface ProjectFile {
  name: string;
  content: string;
}

export interface HexBuild {
  hex?: string;
  hexKey?: string; // content-addressed firmware image key (invariant I5)
  elfBytes?: number;
  diagnostics: Diagnostic[];
  libraries: string[]; // preset libraries pulled in
  compiledUnitIds: string[]; // units compiled this build
  reusedUnitIds: string[]; // units served from the object cache (incremental)
  fromFirmwareCache: boolean; // whole firmware served from OPFS without the toolchain
}

// Compiler/flags identity; combined with the fixtures buildId (SDK+libraries content
// hash from manifest.json) so the firmware-HEX cache invalidates on any input change.
const FIRMWARE_CACHE_VERSION = 'avr-uno|avr-gcc-wasm@14.2|-Os|v1';
const FIRMWARE_CACHE_DIR = '/firmware-cache';
const FIRMWARE_CACHE_MAX = 200; // bound OPFS growth across a long editing session

let buildIdPromise: Promise<string> | null = null;
/** Fixtures content id (memoized); part of the firmware cache key (I5). */
function fixturesBuildId(): Promise<string> {
  if (!buildIdPromise) {
    buildIdPromise = fetch('/toolchain/manifest.json')
      .then((r) => (r.ok ? r.json() : { buildId: 'no-manifest' }))
      .then((m: { buildId?: string }) => m.buildId ?? 'no-manifest')
      .catch(() => 'no-manifest');
  }
  return buildIdPromise;
}

const REAL_SDK: SdkConfig = {
  target: 'avr-atmega328p',
  compilerId: 'avr-gcc-wasm@14.2',
  sdkPackHash: 'sha256:arduino-avr-core',
  libraryPackHash: 'sha256:preset-libs',
  boardId: 'uno',
  frameworkVersion: 'arduino-avr@1.8.8',
  toolchainPackHash: 'sha256:avr-gcc-wasm-14.2',
};
const ARDUINO_BASE = [
  '-DF_CPU=16000000L',
  '-DARDUINO=10808',
  '-DARDUINO_AVR_UNO',
  '-DARDUINO_ARCH_AVR',
  '-ffunction-sections',
  '-fdata-sections',
];

let realPromise: Promise<{ daemon: BuildDaemonImpl; rt: RealToolchain }> | null = null;

/** Lazily build (once) the real-toolchain daemon, sharing the session's OPFS fs/index. */
async function realBuild(): Promise<{ daemon: BuildDaemonImpl; rt: RealToolchain }> {
  if (!realPromise) {
    realPromise = (async () => {
      const { fs, index } = await ready();
      const rt = await loadRealToolchain();
      const daemon = new BuildDaemonImpl(fs, index);
      daemon.setToolchain(rt.toolchain);
      daemon.setProfile('hardware'); // -Os, closest to real Arduino firmware
      daemon.setBaseFlags([...ARDUINO_BASE, ...rt.includeFlags]);
      daemon.configureSdk(
        REAL_SDK,
        [],
        rt.libraries.map((l) => ({
          name: l.name,
          version: l.version,
          includePath: l.mount,
          providesHeaders: l.provides,
          architectures: ['avr'],
        })),
      );
      await daemon.start();
      return { daemon, rt };
    })();
  }
  return realPromise;
}

const encode = new TextEncoder();

interface CachedFirmware {
  hex: string;
  hexKey: string;
  elfBytes: number;
  libraries: string[];
  diagnostics: Diagnostic[];
}

async function buildProject(files: ProjectFile[]): Promise<HexBuild> {
  // Firmware-HEX fast path: if this exact project was built before, serve the cached
  // HEX straight from OPFS — no toolchain download/instantiation (gate #2: cached run).
  const { fs } = await ready();
  // The firmware-HEX cache key must include the user libraries — changing/removing one must rebuild.
  const cacheKey = await sha256(
    `${FIRMWARE_CACHE_VERSION}|${await fixturesBuildId()}\n${JSON.stringify(files)}\n${JSON.stringify(userLibraries)}`,
  );
  const cachePath = `${FIRMWARE_CACHE_DIR}/${cacheKey.replace('sha256:', '')}.json`;
  if (await fs.exists(cachePath)) {
    const cached = JSON.parse(await fs.readFileText(cachePath)) as CachedFirmware;
    return {
      hex: cached.hex,
      hexKey: cached.hexKey,
      elfBytes: cached.elfBytes,
      diagnostics: cached.diagnostics,
      libraries: cached.libraries,
      compiledUnitIds: [],
      reusedUnitIds: [],
      fromFirmwareCache: true,
    };
  }

  const { daemon, rt } = await realBuild();

  // Mount user-uploaded libraries (headers → compiler FS + dep-scan + cache key) and add their include
  // paths to the build flags so a sketch's `#include <UserLib.h>` resolves. Always reset the flags so a
  // removed library stops being searched.
  const libs = buildLibraries();
  daemon.setUserLibraries(
    libs.map((lib) => ({
      name: lib.name,
      version: lib.version,
      includePath: userLibPath(lib.name),
      provides: lib.provides,
      headers: lib.headers.map((h) => ({ name: h.rel, bytes: encode.encode(h.content) })),
    })),
  );
  const userIncludeFlags = libs.flatMap((lib) => ['-I', userLibPath(lib.name)]);
  daemon.setBaseFlags([...ARDUINO_BASE, ...rt.includeFlags, ...userIncludeFlags]);

  // Resolve which libraries (preset + uploaded) the project #includes (transitively).
  const includes = files.flatMap((f) => scanIncludeDirectives(f.content).map((d) => d.name));
  const catalog: LibraryCatalogEntry[] = [
    ...rt.libraries.map((l) => ({
      name: l.name,
      version: l.version,
      provides: l.provides,
      architectures: ['avr', '*'],
      depends: l.depends.map((name) => ({ name })),
      srcDir: l.mount,
      headers: l.provides,
    })),
    ...libs.map((lib) => ({
      name: lib.name,
      version: lib.version,
      provides: lib.provides,
      architectures: ['avr', '*'],
      depends: [],
      srcDir: userLibPath(lib.name),
      headers: lib.provides,
    })),
  ];
  const resolved = resolveLibraries({ includes, catalog, architecture: 'avr' });
  const usedLibs = resolved.libraries.map((r) => r.name);
  const libSources: ProjectSource[] = [
    ...rt.libraries
      .filter((l) => usedLibs.includes(l.name))
      .flatMap((l) => l.sources.map((s) => ({ id: s.id, bytes: s.bytes, language: s.language }))),
    ...libs
      .filter((lib) => usedLibs.includes(lib.name))
      .flatMap((lib) =>
        lib.sources.map((s) => ({
          id: `${userLibPath(lib.name)}/${s.rel}`,
          bytes: encode.encode(s.content),
          language: s.language,
        })),
      ),
  ];

  // .ino tabs → one preprocessed translation unit; .cpp/.c tabs compile as-is.
  const inos = files.filter((f) => f.name.endsWith('.ino'));
  const project: ProjectSource[] = [];
  if (inos.length) {
    const { cpp } = preprocessSketch(inos.map((f) => ({ name: f.name, content: f.content })));
    project.push({ id: 'sketch.cpp', bytes: encode.encode(cpp), language: 'c++' });
  }
  for (const f of files) {
    if (f.name.endsWith('.cpp'))
      project.push({ id: f.name, bytes: encode.encode(f.content), language: 'c++' });
    else if (f.name.endsWith('.c'))
      project.push({ id: f.name, bytes: encode.encode(f.content), language: 'c' });
  }
  project.push(...libSources);

  daemon.setProject(project);
  const outcome = await daemon.build();

  const base: Omit<HexBuild, 'hex' | 'elfBytes' | 'hexKey'> = {
    diagnostics: outcome.diagnostics,
    libraries: usedLibs,
    compiledUnitIds: outcome.compiledUnitIds,
    reusedUnitIds: outcome.reusedUnitIds,
    fromFirmwareCache: false,
  };
  if (!outcome.elfPath || outcome.diagnostics.some((d) => d.severity === 'error')) return base;

  // ELF → Intel HEX via avr-objcopy (authoritative); content-address via image-packer.
  const elf = await fs.readFile(outcome.elfPath);
  const oc = await rt.objcopy.run({
    args: ['-O', 'ihex', '/b.elf', '/b.hex'],
    inputs: [{ path: '/b.elf', bytes: elf }],
    outputs: ['/b.hex'],
  });
  const hexBytes = oc.outputs.get('/b.hex');
  if (!hexBytes) return base;
  const image = await hexImageFromText(new TextDecoder().decode(hexBytes));

  // Persist the firmware-HEX cache so a later identical build skips the toolchain.
  const cacheEntry: CachedFirmware = {
    hex: image.hex,
    hexKey: image.hexKey,
    elfBytes: elf.length,
    libraries: usedLibs,
    diagnostics: outcome.diagnostics,
  };
  await evictFirmwareCacheIfFull(fs);
  await fs.writeFile(cachePath, encode.encode(JSON.stringify(cacheEntry))); // writeFile creates dirs

  return { ...base, elfBytes: elf.length, hex: image.hex, hexKey: image.hexKey };
}

/** Bound the firmware-HEX cache: drop a batch once it exceeds the cap (content-addressed,
 *  so eviction order doesn't matter — a dropped entry just recompiles next time). */
async function evictFirmwareCacheIfFull(fs: VirtualFs): Promise<void> {
  if (!(await fs.exists(FIRMWARE_CACHE_DIR))) return;
  const entries = await fs.list(FIRMWARE_CACHE_DIR);
  if (entries.length < FIRMWARE_CACHE_MAX) return;
  for (const name of entries.slice(0, Math.ceil(FIRMWARE_CACHE_MAX / 4))) {
    await fs.remove(`${FIRMWARE_CACHE_DIR}/${name}`);
  }
}

export type BuildWorkerApi = typeof api;

Comlink.expose(api);
