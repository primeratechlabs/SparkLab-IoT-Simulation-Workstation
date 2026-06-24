/**
 * Library resolver — REFERENCE-SPEC Stage 2. Resolves `#include`s to libraries
 * the way arduino-cli does: include-driven, architecture-filtered, with priority
 * rules and transitive `depends`. The catalog source (project-local / library
 * index / GitHub / upload) is abstracted; this module is the pure resolution
 * logic so it unit-tests without network.
 */

import type { ResolvedLibrary } from '@sparklab/shared';

export interface LibraryCatalogEntry {
  name: string;
  version: string;
  /** Header names this library provides (e.g. "DHT.h", "Adafruit_Sensor.h"). */
  provides: string[];
  architectures: string[]; // e.g. ["avr"], ["*"]
  depends?: { name: string; constraint?: string }[];
  srcDir: string;
  headers: string[];
  source?: ResolvedLibrary['source'];
}

function supportsArch(entry: LibraryCatalogEntry, arch: string): boolean {
  return entry.architectures.includes('*') || entry.architectures.includes(arch);
}

/** Arduino-style priority: a library whose name matches the header basename wins. */
function priority(entry: LibraryCatalogEntry, header: string): number {
  const base = header.replace(/\.h$/i, '').toLowerCase();
  if (entry.name.toLowerCase() === base) return 3;
  if (entry.provides.some((h) => h.replace(/\.h$/i, '').toLowerCase() === base)) return 2;
  return 1;
}

function toResolved(entry: LibraryCatalogEntry): ResolvedLibrary {
  return {
    name: entry.name,
    version: entry.version,
    srcDir: entry.srcDir,
    headers: entry.headers,
    depends: entry.depends ?? [],
    architectures: entry.architectures,
    source: entry.source ?? 'registry',
  };
}

export interface ResolveOptions {
  includes: string[];
  catalog: LibraryCatalogEntry[];
  architecture: string;
}

export interface ResolveResult {
  libraries: ResolvedLibrary[];
  /** Includes that matched no library (system headers or unresolved). */
  unresolved: string[];
}

export function resolveLibraries(opts: ResolveOptions): ResolveResult {
  const { includes, catalog, architecture } = opts;
  const chosen = new Map<string, LibraryCatalogEntry>();
  const unresolved: string[] = [];

  const pick = (header: string): LibraryCatalogEntry | null => {
    const candidates = catalog
      .filter((e) => supportsArch(e, architecture) && e.provides.includes(header))
      .sort((a, b) => priority(b, header) - priority(a, header));
    return candidates[0] ?? null;
  };

  // Resolve direct includes, then transitively pull `depends`.
  const queue = [...includes];
  const visitedHeaders = new Set<string>();
  while (queue.length) {
    const header = queue.shift()!;
    if (visitedHeaders.has(header)) continue;
    visitedHeaders.add(header);

    const entry = pick(header);
    if (!entry) {
      unresolved.push(header);
      continue;
    }
    if (!chosen.has(entry.name)) {
      chosen.set(entry.name, entry);
      for (const dep of entry.depends ?? []) {
        const depEntry = catalog.find((e) => e.name === dep.name && supportsArch(e, architecture));
        if (depEntry && !chosen.has(depEntry.name)) {
          // Enqueue the dependency's primary header so it resolves uniformly.
          queue.push(depEntry.provides[0] ?? `${depEntry.name}.h`);
        }
      }
    }
  }

  return {
    libraries: [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name)).map(toResolved),
    unresolved,
  };
}
