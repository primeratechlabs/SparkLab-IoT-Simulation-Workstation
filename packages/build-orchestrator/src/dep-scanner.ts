/**
 * Header dependency scanner — REFERENCE-SPEC §37 (source). NOT a full C++ parser:
 * it scans `#include` directives, resolves them against SDK/library include paths
 * (Arduino library priority), hashes the transitive header tree, and records which
 * libraries a unit pulls in. Output feeds the object cache key (so editing a header
 * recompiles only dependents) and library selection.
 *
 * Incremental: units whose sourceKey is unchanged reuse their previous scan.
 */

import type { Sha256, DependencyGraph, ResolvedLibrary } from '@sparklab/shared';
import { sha256, sha256OfHashes } from '@sparklab/shared';
import { SdkMount } from '@sparklab/toolchain-loader';
import { scrubComments } from './scrub.js';

export interface SourceUnit {
  id: string;
  sourceKey: Sha256;
  sourceBytes: Uint8Array;
}

export interface IncludeDirective {
  name: string;
  system: boolean; // <...> vs "..."
}

const INCLUDE_RE = /^\s*#\s*include\s*[<"]([^>"]+)[">]/;

export function scanIncludeDirectives(source: string): IncludeDirective[] {
  const out: IncludeDirective[] = [];
  // Scrub comments (keep strings, so the #include "x" form survives) — a commented-out
  // #include is not treated as a real one; the ^# anchor handles string-embedded text.
  for (const line of scrubComments(source).split('\n')) {
    const m = line.match(INCLUDE_RE);
    if (m) out.push({ name: m[1]!, system: line.includes('<') });
  }
  return out;
}

/** Maps include names to libraries (Arduino-style library resolution). */
export class LibraryIndex {
  private byHeader = new Map<string, ResolvedLibrary>();

  add(lib: ResolvedLibrary, providesHeaders: string[]): void {
    for (const h of providesHeaders) this.byHeader.set(h, lib);
  }

  resolve(headerName: string): ResolvedLibrary | null {
    return this.byHeader.get(headerName) ?? null;
  }
}

export interface UnitScan {
  id: string;
  sourceKey: Sha256;
  includes: string[]; // resolved header paths, sorted
  headerHashes: Sha256[]; // sorted, for the object cache key
  headerTreeHash: Sha256;
  libraries: string[]; // library names used by this unit
}

export interface DepScanResult {
  graph: DependencyGraph;
  units: UnitScan[];
  libraries: ResolvedLibrary[];
}

const decoder = new TextDecoder();

async function scanUnit(
  unit: SourceUnit,
  mount: SdkMount,
  libraryIndex: LibraryIndex,
): Promise<{ scan: UnitScan; libs: Map<string, ResolvedLibrary> }> {
  const source = decoder.decode(unit.sourceBytes);
  const resolvedPaths = new Set<string>();
  const headerHashes: Sha256[] = [];
  const libs = new Map<string, ResolvedLibrary>();

  // BFS over the include graph (header → header), resolving via the mount.
  const queue = scanIncludeDirectives(source).map((d) => d.name);
  const visited = new Set<string>();
  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const lib = libraryIndex.resolve(name);
    if (lib) libs.set(lib.name, lib);

    const header = mount.resolve(name);
    if (!header) continue; // unresolved (system header without source) → skipped, not an error
    if (!resolvedPaths.has(header.path)) {
      resolvedPaths.add(header.path);
      headerHashes.push(await sha256(header.bytes));
      for (const d of scanIncludeDirectives(decoder.decode(header.bytes))) queue.push(d.name);
    }
  }

  const includes = [...resolvedPaths].sort();
  const sortedHashes = [...headerHashes].sort();
  const headerTreeHash = await sha256OfHashes(sortedHashes);
  return {
    scan: {
      id: unit.id,
      sourceKey: unit.sourceKey,
      includes,
      headerHashes: sortedHashes,
      headerTreeHash,
      libraries: [...libs.keys()].sort(),
    },
    libs,
  };
}

function assemble(unitScans: UnitScan[], libMap: Map<string, ResolvedLibrary>): DepScanResult {
  const libraries = [...libMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    graph: {
      units: unitScans.map((u) => ({ id: u.id, sourceKey: u.sourceKey, includes: u.includes })),
      libraries,
    },
    units: unitScans,
    libraries,
  };
}

export async function buildDependencyGraph(opts: {
  units: SourceUnit[];
  mount: SdkMount;
  libraryIndex: LibraryIndex;
}): Promise<DepScanResult> {
  const scans: UnitScan[] = [];
  const libMap = new Map<string, ResolvedLibrary>();
  for (const unit of opts.units) {
    const { scan, libs } = await scanUnit(unit, opts.mount, opts.libraryIndex);
    scans.push(scan);
    for (const [k, v] of libs) libMap.set(k, v);
  }
  return assemble(scans, libMap);
}

/**
 * Incremental rescan: only units whose sourceKey changed are re-scanned; the rest
 * reuse their previous UnitScan. Returns the new full result.
 */
export async function updateDependencyGraph(
  prev: DepScanResult,
  opts: { units: SourceUnit[]; mount: SdkMount; libraryIndex: LibraryIndex },
): Promise<{ result: DepScanResult; rescannedUnitIds: string[] }> {
  const prevById = new Map(prev.units.map((u) => [u.id, u]));
  const scans: UnitScan[] = [];
  const libMap = new Map<string, ResolvedLibrary>();
  const rescannedUnitIds: string[] = [];

  const prevLibByName = new Map(prev.libraries.map((l) => [l.name, l]));
  for (const unit of opts.units) {
    const prevScan = prevById.get(unit.id);
    if (prevScan && prevScan.sourceKey === unit.sourceKey) {
      scans.push(prevScan);
      for (const name of prevScan.libraries) {
        const lib = prevLibByName.get(name);
        if (lib) libMap.set(name, lib);
      }
      continue;
    }
    rescannedUnitIds.push(unit.id);
    const { scan, libs } = await scanUnit(unit, opts.mount, opts.libraryIndex);
    scans.push(scan);
    for (const [k, v] of libs) libMap.set(k, v);
  }

  return { result: assemble(scans, libMap), rescannedUnitIds };
}
