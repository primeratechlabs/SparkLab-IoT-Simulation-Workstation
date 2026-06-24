/**
 * Loads the real AVR toolchain (cc1/cc1plus/avr-as/avr-ld/avr-objcopy WASM modules
 * + SDK + preset libraries) in the browser — Stage 2. The Emscripten ES modules are
 * fetched and blob-imported (no server compile, invariant I8). Intended to run in a
 * Worker (invariant I2). The actual multi-file/incremental build is orchestrated by
 * the BuildDaemon in build.worker.ts; this module just assembles the toolchain.
 */
import {
  WasmAvrToolchain,
  WasmTool,
  type AvrSdk,
  type EmscriptenModuleFactory,
} from '@sparklab/toolchain-loader';
import {
  fetchIntegrityManifest,
  fetchVerifiedBytes,
  verifyIfPinned,
  type IntegrityManifest,
} from './asset-integrity.js';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fetch an Emscripten ES module, VERIFY its integrity pin (AUD-013), then import it from a blob URL. */
async function blobImport(
  url: string,
  name: string,
  manifest: IntegrityManifest | null,
): Promise<EmscriptenModuleFactory> {
  const bytes = await fetchVerifiedBytes(url, name, manifest);
  const text = new TextDecoder().decode(bytes);
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as { default: EmscriptenModuleFactory };
    return mod.default;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

interface SdkJson {
  headerMounts: { mount: string; files: { path: string; b64: string }[] }[];
  crt: string;
  coreA: string;
  libs: { name: string; b64: string }[];
  ldscript: string;
}

interface LibraryJson {
  name: string;
  version: string;
  provides: string[];
  depends: string[];
  mount: string;
  includePaths: string[];
  headers: { path: string; b64: string }[];
  sources: { path: string; b64: string; language: 'c' | 'c++' }[];
}

/** A preset library available to compile against (headers already mounted). */
export interface LibrarySpec {
  name: string;
  version: string;
  provides: string[];
  depends: string[];
  mount: string;
  includePaths: string[];
  sources: { id: string; bytes: Uint8Array; language: 'c' | 'c++' }[];
}

export interface RealToolchain {
  toolchain: WasmAvrToolchain;
  objcopy: WasmTool;
  libraries: LibrarySpec[];
  /** -I flags for every library include path (added to the daemon's base flags). */
  includeFlags: string[];
}

export async function loadRealToolchain(base = '/toolchain'): Promise<RealToolchain> {
  const manifest = await fetchIntegrityManifest(base); // AUD-013 — verify every self-hosted asset before use
  const [cc1, cc1plus, avrAs, avrLd, avrObjcopy] = await Promise.all([
    blobImport(`${base}/cc1.mjs`, 'cc1.mjs', manifest),
    blobImport(`${base}/cc1plus.mjs`, 'cc1plus.mjs', manifest),
    blobImport(`${base}/avr-as.mjs`, 'avr-as.mjs', manifest),
    blobImport(`${base}/avr-ld.mjs`, 'avr-ld.mjs', manifest),
    blobImport(`${base}/avr-objcopy.mjs`, 'avr-objcopy.mjs', manifest),
  ]);
  const [sdkJson, libsJson] = await Promise.all([
    fetchVerifiedBytes(`${base}/sdk.json`, 'sdk.json', manifest).then(
      (b) => JSON.parse(new TextDecoder().decode(b)) as SdkJson,
    ),
    // libraries.json is OPTIONAL: fetch once; if served, verify it when the manifest pins it (a tampered
    // optional asset is still caught), but an absent pin is allowed (verifyIfPinned, not enforcePin).
    fetch(`${base}/libraries.json`).then(async (r) => {
      if (!r.ok) return [] as LibraryJson[];
      const b = await verifyIfPinned(
        new Uint8Array(await r.arrayBuffer()),
        'libraries.json',
        manifest,
      );
      return JSON.parse(new TextDecoder().decode(b)) as LibraryJson[];
    }),
  ]);

  const libraries: LibrarySpec[] = libsJson.map((l) => ({
    name: l.name,
    version: l.version,
    provides: l.provides,
    depends: l.depends,
    mount: l.mount,
    includePaths: l.includePaths,
    sources: l.sources.map((s) => ({ id: s.path, bytes: b64ToBytes(s.b64), language: s.language })),
  }));

  const sdk: AvrSdk = {
    headerMounts: [
      ...sdkJson.headerMounts.map((m) => ({
        mount: m.mount,
        files: m.files.map((f) => ({ path: f.path, bytes: b64ToBytes(f.b64) })),
      })),
      // Mount every preset library's headers; arch/include guards keep unused ones out.
      ...libsJson.map((l) => ({
        mount: l.mount,
        files: l.headers.map((f) => ({ path: f.path, bytes: b64ToBytes(f.b64) })),
      })),
    ],
    crt: b64ToBytes(sdkJson.crt),
    coreA: b64ToBytes(sdkJson.coreA),
    libs: sdkJson.libs.map((l) => ({ name: l.name, bytes: b64ToBytes(l.b64) })),
    ldscript: b64ToBytes(sdkJson.ldscript),
  };

  return {
    toolchain: new WasmAvrToolchain({ cc1, cc1plus, avrAs, avrLd }, sdk),
    objcopy: new WasmTool(avrObjcopy, 'avr-objcopy'),
    libraries,
    includeFlags: libraries.flatMap((l) => l.includePaths.flatMap((p) => ['-I', p])),
  };
}
