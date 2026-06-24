/**
 * Build orchestrator session — the long-lived build daemon's core (REFERENCE-SPEC
 * §14). Holds a warm toolchain, the SDK header mount + library index, and the
 * content-addressed object/firmware caches. Implements the BuildDaemon interface
 * (types.ts) plus a convenience build() pipeline that the Stage 1 gate drives.
 *
 * Heavy work is intended to run in a Worker (invariant I2); this class is
 * environment-agnostic so it unit-tests in Node with in-memory fs/index.
 */

import type {
  Sha256,
  CompileRequest,
  CompileResult,
  LinkResult,
  ImageResult,
  DependencyGraph,
  Diagnostic,
} from '@sparklab/shared';
import { sha256 } from '@sparklab/shared';
import type { VirtualFs, BuildIndex } from '@sparklab/opfs';
import {
  type Toolchain,
  SdkMount,
  loadToolchain,
  toolchainInstantiations,
} from '@sparklab/toolchain-loader';
import { ObjectCache } from './ccache.js';
import {
  LibraryIndex,
  buildDependencyGraph,
  type SourceUnit,
  type DepScanResult,
} from './dep-scanner.js';
import { planBuildUnits, type BuildUnitInput, type BuildUnitPlan } from './graph.js';
import type { OptimizationProfileId } from './optimization-profiles.js';
import { scheduleBuild } from './scheduler.js';
import { linkObjects, storeFirmware } from './link.js';
import { translateDiagnostics } from './error-translator.js';
import { isValidElf } from '@sparklab/toolchain-loader';

export interface SdkConfig {
  target: string;
  compilerId?: string;
  sdkPackHash: Sha256;
  libraryPackHash: Sha256;
  boardId: string;
  frameworkVersion: string;
  toolchainPackHash: Sha256;
  linkerScriptHash?: Sha256;
  partitionTableHash?: Sha256;
}

export interface ProjectSource {
  id: string;
  bytes: Uint8Array;
  /** Compiler language; inferred from the id extension (.c → 'c') when omitted. */
  language?: 'c' | 'c++';
}

export interface BuildOutcome {
  fromFirmwareCache: boolean;
  objectKeys: Sha256[];
  compiledUnitIds: string[];
  reusedUnitIds: string[];
  firmwareKey: Sha256 | null;
  elfPath: string | null;
  elfValid: boolean;
  diagnostics: Diagnostic[];
  toolchainInstantiations: number;
}

export class BuildDaemonImpl {
  private toolchain: Toolchain;
  private cache: ObjectCache;
  private mount = new SdkMount();
  private libraryIndex = new LibraryIndex();
  private sources = new Map<string, ProjectSource>();
  private sdk: SdkConfig | null = null;
  private lastScan: DepScanResult | null = null;
  private baseFlags: string[] = [];
  private profile: OptimizationProfileId = 'simulation';
  /** User-uploaded library headers written into every compile's FS (their bytes; the dep-scan picks up
   *  the includes via the mount, so the object cache keys them). Replaced by setUserLibraries. */
  private userExtraHeaders: { path: string; bytes: Uint8Array }[] = [];

  constructor(
    private readonly fs: VirtualFs,
    private readonly index: BuildIndex,
    variant: 'threaded' | 'singlethread' = 'singlethread',
  ) {
    this.toolchain = loadToolchain(variant);
    this.cache = new ObjectCache(fs, index);
  }

  /**
   * Swap in a real toolchain (Stage 2: WasmAvrToolchain) — the orchestrator,
   * caches and scheduler are unchanged; only the compiler identity differs (so its
   * objects key separately from the stub's, invariant I5).
   */
  setToolchain(toolchain: Toolchain): void {
    this.toolchain = toolchain;
  }

  /** Flags prepended to every compile (Arduino defines + library -I paths). */
  setBaseFlags(flags: string[]): void {
    this.baseFlags = [...flags];
  }

  /** Optimization profile (e.g. 'hardware' = -Os, closest to real Arduino firmware). */
  setProfile(profile: OptimizationProfileId): void {
    this.profile = profile;
  }

  async start(): Promise<void> {
    // Toolchain is loaded warm in the constructor; nothing else to do for the stub.
  }

  async stop(): Promise<void> {
    this.sources.clear();
  }

  /** Register the SDK header mount + library index (read-only includes). */
  configureSdk(
    sdk: SdkConfig,
    headers: Array<{ includePath: string; name: string; bytes: Uint8Array; library?: string }> = [],
    libraries: Array<{
      name: string;
      version: string;
      includePath: string;
      providesHeaders: string[];
      architectures: string[];
    }> = [],
  ): void {
    this.sdk = sdk;
    for (const lib of libraries) {
      this.mount.addIncludePath(lib.includePath, lib.name);
      this.libraryIndex.add(
        {
          name: lib.name,
          version: lib.version,
          srcDir: lib.includePath,
          headers: lib.providesHeaders,
          depends: [],
          architectures: lib.architectures,
          source: 'prebuilt-pack',
        },
        lib.providesHeaders,
      );
    }
    for (const h of headers) this.mount.registerHeader(h.includePath, h.name, h.bytes);
  }

  /**
   * Mount user-uploaded libraries (parsed from a .zip): register each header so the dep-scan resolves
   * its `#include` + the object cache keys it, add it to the library index, and keep the header bytes to
   * write into every compile's FS. Replaces the prior user set (removed libraries stop being mounted).
   */
  setUserLibraries(
    libs: Array<{
      name: string;
      version: string;
      includePath: string;
      provides: string[];
      headers: { name: string; bytes: Uint8Array }[];
    }>,
  ): void {
    this.userExtraHeaders = [];
    for (const lib of libs) {
      this.mount.addIncludePath(lib.includePath, lib.name);
      this.libraryIndex.add(
        {
          name: lib.name,
          version: lib.version,
          srcDir: lib.includePath,
          headers: lib.provides,
          depends: [],
          architectures: ['avr', 'esp32', '*'],
          source: 'prebuilt-pack',
        },
        lib.provides,
      );
      for (const h of lib.headers) {
        this.mount.registerHeader(lib.includePath, h.name, h.bytes);
        this.userExtraHeaders.push({ path: `${lib.includePath}/${h.name}`, bytes: h.bytes });
      }
    }
  }

  setProject(sources: ProjectSource[]): void {
    this.sources.clear();
    for (const s of sources) this.sources.set(s.id, s);
  }

  upsertSource(source: ProjectSource): void {
    this.sources.set(source.id, source);
  }

  /** Explicit source language, else inferred from the id (.c → C, otherwise C++). */
  private languageOf(id: string): 'c' | 'c++' {
    const explicit = this.sources.get(id)?.language;
    if (explicit) return explicit;
    return id.endsWith('.c') ? 'c' : 'c++';
  }

  private async sourceUnits(): Promise<SourceUnit[]> {
    const units: SourceUnit[] = [];
    for (const s of this.sources.values()) {
      units.push({ id: s.id, sourceKey: await sha256(s.bytes), sourceBytes: s.bytes });
    }
    return units;
  }

  async scanDependencies(_projectId?: string): Promise<DependencyGraph> {
    const units = await this.sourceUnits();
    this.lastScan = await buildDependencyGraph({
      units,
      mount: this.mount,
      libraryIndex: this.libraryIndex,
    });
    return this.lastScan.graph;
  }

  /** Full build pipeline used by the Stage 1 gate. */
  async build(): Promise<BuildOutcome> {
    if (!this.sdk) throw new Error('SDK not configured');
    const units = await this.sourceUnits();
    const buildInputs: BuildUnitInput[] = units.map((u) => ({
      id: u.id,
      sourceKey: u.sourceKey,
      sourceBytes: u.sourceBytes,
      language: this.languageOf(u.id),
    }));

    this.lastScan = await buildDependencyGraph({
      units,
      mount: this.mount,
      libraryIndex: this.libraryIndex,
    });

    const plans: BuildUnitPlan[] = planBuildUnits(buildInputs, this.lastScan.units, {
      target: this.sdk.target,
      compilerId: this.toolchain.id,
      sdkPackHash: this.sdk.sdkPackHash,
      libraryPackHash: this.sdk.libraryPackHash,
      baseFlags: this.baseFlags,
      profile: this.profile,
    });

    const scheduled = await scheduleBuild({
      plans,
      cache: this.cache,
      toolchain: this.toolchain,
      index: this.index,
      ...(this.userExtraHeaders.length ? { extraHeaders: this.userExtraHeaders } : {}),
    });

    // Translate compiler/linker diagnostics to beginner-friendly text at the source (every consumer —
    // the build worker, tests — gets the `friendly` field; idempotent, so a later re-translate is a no-op).
    const diagnostics = translateDiagnostics([...scheduled.diagnostics]);
    if (diagnostics.some((d) => d.severity === 'error')) {
      return {
        fromFirmwareCache: false,
        objectKeys: scheduled.objectKeys,
        compiledUnitIds: scheduled.compiledUnitIds,
        reusedUnitIds: scheduled.reusedUnitIds,
        firmwareKey: null,
        elfPath: null,
        elfValid: false,
        diagnostics,
        toolchainInstantiations: toolchainInstantiations(),
      };
    }

    // Link: read objects back from cache (stable order = plan order). A missing
    // record is index/disk drift — abort rather than link a partial firmware.
    const objects: Uint8Array[] = [];
    for (const key of scheduled.objectKeys) {
      const rec = await this.index.getObject(key);
      if (!rec) throw new Error(`object cache drift: missing record for ${key}`);
      objects.push(await this.fs.readFile(rec.path));
    }
    const linked = await linkObjects(this.toolchain, objects, this.sdk.target);
    diagnostics.push(...translateDiagnostics(linked.diagnostics)); // link errors (e.g. undefined `countPulseASM`)

    const stored = await storeFirmware(
      this.fs,
      this.index,
      {
        boardId: this.sdk.boardId,
        mcuTarget: this.sdk.target,
        frameworkVersion: this.sdk.frameworkVersion,
        toolchainPackHash: this.sdk.toolchainPackHash,
        sdkPackHash: this.sdk.sdkPackHash,
        objectKeys: scheduled.objectKeys,
        staticLibraryHashes: [],
        linkerScriptHash: this.sdk.linkerScriptHash ?? 'sha256:none',
        partitionTableHash: this.sdk.partitionTableHash ?? 'sha256:none',
        imagePackerVersion: 'stub-packer@1',
        simulationProfileId: 'simulation',
      },
      linked.elf,
    );

    return {
      fromFirmwareCache: scheduled.fromFirmwareCache,
      objectKeys: scheduled.objectKeys,
      compiledUnitIds: scheduled.compiledUnitIds,
      reusedUnitIds: scheduled.reusedUnitIds,
      firmwareKey: stored.firmwareKey,
      elfPath: stored.elfPath,
      elfValid: isValidElf(linked.elf),
      diagnostics,
      toolchainInstantiations: toolchainInstantiations(),
    };
  }

  // ── BuildDaemon interface (types.ts) — minimal Stage 1 surface ──────────

  async compile(req: CompileRequest): Promise<CompileResult> {
    const start = Date.now();
    let source: ProjectSource | undefined;
    for (const s of this.sources.values()) {
      if ((await sha256(s.bytes)) === req.sourceKey) {
        source = s;
        break;
      }
    }
    if (!source) {
      return { status: 'error', diagnostics: [diag('unknown sourceKey')], timeMs: 0 };
    }
    const out = await this.toolchain.compile({
      sourceKey: req.sourceKey,
      sourceBytes: source.bytes,
      target: req.target,
      flags: req.flags,
      includedHeaderHashes: [],
    });
    return {
      status: out.diagnostics.some((d) => d.severity === 'error') ? 'error' : 'ok',
      diagnostics: translateDiagnostics(out.diagnostics),
      timeMs: Date.now() - start,
    };
  }

  async link(_targetId: string): Promise<LinkResult> {
    return { status: 'error', diagnostics: [diag('use build() in Stage 1')], timeMs: 0 };
  }

  async packImage(_targetId: string): Promise<ImageResult> {
    // Image packing (HEX/flash) implemented in Stage 2/4.
    return { status: 'error', timeMs: 0 };
  }
}

function diag(message: string): Diagnostic {
  return { severity: 'error', file: '<daemon>', line: 0, message };
}
