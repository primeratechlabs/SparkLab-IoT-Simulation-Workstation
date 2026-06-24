/**
 * Loads the real ESP32-C3 RISC-V toolchain (clang + ld.lld WASM modules) + the minimized C3 SDK
 * header pack in the browser — Stage 4, client-side (no server compile, invariant I8). Mirrors
 * real-toolchain.ts (AVR): the Emscripten ES modules are fetched + blob-imported, the SDK ships as
 * one content pack (base64), and both are mounted into the WasmRiscvToolchain that build.worker drives.
 * Intended to run in a Worker (invariant I2). Heavy first load — call only when a C3 board first runs.
 */
import {
  WasmRiscvToolchain,
  type EmscriptenModuleFactory,
  type ToolInput,
} from '@sparklab/toolchain-loader';
import {
  fetchIntegrityManifest,
  fetchVerifiedBytes,
  type IntegrityManifest,
} from './asset-integrity.js';

/** Virtual MEMFS root the SDK is mounted under — the flags (esp32-c3-build) resolve every path from it. */
export const C3_SDK_ROOT = '/c3-sdk';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fetch an Emscripten ES module, VERIFY it against its integrity pin (AUD-013), then import it from a blob
 *  URL (its default export = the factory). Tampering throws before the module is ever imported/executed. */
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

interface C3SdkPack {
  /** Header-closure files, paths relative to C3_SDK_ROOT. */
  files: { path: string; b64: string }[];
  /** The Arduino HAL sim runtime (esp32c3-arduino-sim.cpp), base64. */
  runtime: string;
  /** Standard-library archives (picolibc libc.a/libm.a + libgcc.a), base64, keyed by filename. */
  archives?: { name: string; b64: string }[];
}

export interface RealRiscvToolchain {
  toolchain: WasmRiscvToolchain;
  /** The SDK header pack, mounted read-only into MEMFS per compile. */
  sdk: ToolInput[];
  /** The HAL shim source to compile + link with the sketch. */
  runtimeSource: Uint8Array;
  /** The MEMFS root the SDK is mounted under (= C3_SDK_ROOT). */
  root: string;
  /** libc/libm/libgcc archives linked in a group so memcpy/malloc/new/std::vector/<math> resolve. */
  archives: { path: string; bytes: Uint8Array }[];
}

/**
 * Assemble the C3 toolchain from self-hosted static assets (`/c3-toolchain/`). One-time heavy load
 * (~100 MB clang+lld); cache the returned object (warm singleton) so N compiles reuse one instance.
 */
export async function loadRealRiscvToolchain(base = '/c3-toolchain'): Promise<RealRiscvToolchain> {
  // Integrity pins (AUD-013): verify every self-hosted asset before it is imported/mounted.
  const manifest = await fetchIntegrityManifest(base);
  const [clang, lld, pack] = await Promise.all([
    blobImport(`${base}/clang.mjs`, 'clang.mjs', manifest),
    blobImport(`${base}/lld.mjs`, 'lld.mjs', manifest),
    fetchVerifiedBytes(`${base}/c3-sdk.json`, 'c3-sdk.json', manifest).then(
      (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as C3SdkPack,
    ),
  ]);
  const sdk: ToolInput[] = pack.files.map((f) => ({
    path: `${C3_SDK_ROOT}/${f.path}`,
    bytes: b64ToBytes(f.b64),
  }));
  const archives = (pack.archives ?? []).map((a) => ({
    path: `/${a.name}`,
    bytes: b64ToBytes(a.b64),
  }));
  return {
    toolchain: new WasmRiscvToolchain({ clang, lld }),
    sdk,
    runtimeSource: b64ToBytes(pack.runtime),
    root: C3_SDK_ROOT,
    archives,
  };
}
