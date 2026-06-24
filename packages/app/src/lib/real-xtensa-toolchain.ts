/**
 * Loads the real ESP32-classic Xtensa toolchain (clang + ld.lld WASM modules) + the minimized
 * arduino-esp32 (classic) SDK header pack in the browser — Stage 5, client-side (no server compile,
 * invariant I8). Mirrors real-riscv-toolchain.ts (C3): the Emscripten ES modules are fetched +
 * blob-imported, the SDK + HAL shim + flat linker script ship as one content pack (base64), and both
 * are mounted into the WasmRiscvToolchain (reused purely as a generic wasm clang/lld driver — the
 * Xtensa-ness lives in the flags) that build.worker drives. Runs in a Worker (I2). Heavy first load —
 * call only when an ESP32-classic board first runs.
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

/** Virtual MEMFS root the SDK is mounted under — the flags (esp32-classic-build) resolve every path from it. */
export const XTENSA_SDK_ROOT = '/esp32-classic-sdk';

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

interface XtensaSdkPack {
  /** Header-closure files, paths relative to XTENSA_SDK_ROOT. */
  files: { path: string; b64: string }[];
  /** The Arduino HAL sim runtime (esp32c3-arduino-sim.cpp — architecture-neutral), base64. */
  runtime: string;
  /** The `.literal`-before-`.text` flat linker script (xtensa-flat.ld), base64. */
  linker: string;
  /** Standard-library archives (Xtensa esp32-multilib picolibc libc.a/libm.a + libgcc.a), base64. */
  archives?: { name: string; b64: string }[];
}

export interface RealXtensaToolchain {
  toolchain: WasmRiscvToolchain;
  /** The SDK header pack, mounted read-only into MEMFS per compile. */
  sdk: ToolInput[];
  /** The HAL shim source to compile + link with the sketch. */
  runtimeSource: Uint8Array;
  /** The flat linker script (passed as a link input). */
  linkerScript: Uint8Array;
  /** The MEMFS root the SDK is mounted under (= XTENSA_SDK_ROOT). */
  root: string;
  /** libc/libm/libgcc archives linked in a group so snprintf/<math>/memcpy/new resolve (real picolibc). */
  archives: { path: string; bytes: Uint8Array }[];
}

/**
 * Assemble the Xtensa toolchain from self-hosted static assets (`/esp32-classic-toolchain/`). One-time
 * heavy load (~85 MB clang+lld); cache the returned object (warm singleton) so N compiles reuse one.
 */
export async function loadRealXtensaToolchain(
  base = '/esp32-classic-toolchain',
): Promise<RealXtensaToolchain> {
  const manifest = await fetchIntegrityManifest(base); // AUD-013
  const [clang, lld, pack] = await Promise.all([
    blobImport(`${base}/clang.mjs`, 'clang.mjs', manifest),
    blobImport(`${base}/lld.mjs`, 'lld.mjs', manifest),
    fetchVerifiedBytes(`${base}/esp32-classic-sdk.json`, 'esp32-classic-sdk.json', manifest).then(
      (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as XtensaSdkPack,
    ),
  ]);
  const sdk: ToolInput[] = pack.files.map((f) => ({
    path: `${XTENSA_SDK_ROOT}/${f.path}`,
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
    linkerScript: b64ToBytes(pack.linker),
    root: XTENSA_SDK_ROOT,
    archives,
  };
}
