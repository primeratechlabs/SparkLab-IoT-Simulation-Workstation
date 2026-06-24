/**
 * Capability benchmarks — REFERENCE-SPEC §15. Run inside a Worker (invariant I2).
 *
 *  - wasmInstantiateMsFor50MB: time to compile+instantiate a ~50MB WASM module
 *    (proxy for toolchain module load throughput).
 *  - opfsWriteMBps / opfsReadMBps: sequential OPFS throughput via a sync access
 *    handle (only available in a Worker).
 */

const FIFTY_MB = 50 * 1024 * 1024; // 52_428_800
const WASM_PAGE = 64 * 1024;

/**
 * Minimal LEB128 unsigned encoder (handles values beyond 2^31).
 * @internal exported for tests; not part of the package public surface.
 */
export function uleb(n: number): number[] {
  if (!(n >= 0)) throw new RangeError(`uleb: value must be non-negative, got ${n}`);
  const out: number[] = [];
  let v = Math.floor(n);
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

/**
 * Build a valid WASM module whose data section carries `dataBytes` of zeros,
 * forcing the engine to scan/allocate ~that many bytes on instantiate.
 */
export function buildLargeWasmModule(dataBytes: number): Uint8Array {
  const pages = Math.ceil(dataBytes / WASM_PAGE);

  // Memory section (id 5): 1 memory, limits = { min: pages }.
  const memContent = [1, 0x00, ...uleb(pages)];
  const memSection = [5, ...uleb(memContent.length), ...memContent];

  // Data section (id 11): 1 active segment @ offset 0, then `dataBytes` zeros.
  const offsetExpr = [0x41, 0x00, 0x0b]; // i32.const 0; end
  const segHeader = [0x00, ...offsetExpr, ...uleb(dataBytes)];
  const dataContent = [1, ...segHeader];
  const dataSectionHeader = [11, ...uleb(dataContent.length + dataBytes)];

  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // \0asm + version 1
  const prefix = [...header, ...memSection, ...dataSectionHeader, ...dataContent];

  const out = new Uint8Array(prefix.length + dataBytes);
  out.set(prefix, 0);
  // remaining bytes already zero-initialized
  return out;
}

export async function benchmarkWasmInstantiate(dataBytes = FIFTY_MB): Promise<number> {
  const bytes = buildLargeWasmModule(dataBytes);
  const start = performance.now();
  await WebAssembly.instantiate(bytes as BufferSource, {});
  return performance.now() - start;
}

async function getBenchDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('.bench', { create: true });
}

interface SyncAccessHandle {
  write(buffer: BufferSource, opts?: { at?: number }): number;
  read(buffer: BufferSource, opts?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}

/** Write then read a ~50MB OPFS file; returns throughput in MB/s for each phase. */
export async function benchmarkOpfs(
  sizeBytes = FIFTY_MB,
): Promise<{ writeMBps: number; readMBps: number }> {
  const dir = await getBenchDir();
  const fileHandle = await dir.getFileHandle('throughput.bin', { create: true });
  const createSync = (
    fileHandle as unknown as { createSyncAccessHandle: () => Promise<SyncAccessHandle> }
  ).createSyncAccessHandle;
  if (typeof createSync !== 'function') {
    throw new Error('createSyncAccessHandle unavailable (must run in a Worker over OPFS)');
  }
  const handle = await createSync.call(fileHandle);
  try {
    const chunk = new Uint8Array(1024 * 1024); // 1MB, filled with a non-zero pattern
    for (let i = 0; i < chunk.length; i++) chunk[i] = i & 0xff;
    const chunks = Math.ceil(sizeBytes / chunk.length);

    handle.truncate(0);
    const wStart = performance.now();
    let offset = 0;
    for (let i = 0; i < chunks; i++) {
      offset += handle.write(chunk, { at: offset });
    }
    handle.flush();
    const writeMs = performance.now() - wStart;

    const readBuf = new Uint8Array(chunk.length);
    const rStart = performance.now();
    offset = 0;
    const total = handle.getSize();
    while (offset < total) {
      const n = handle.read(readBuf, { at: offset });
      if (n <= 0) break;
      offset += n;
    }
    const readMs = performance.now() - rStart;

    const mb = sizeBytes / (1024 * 1024);
    return {
      writeMBps: mb / (writeMs / 1000),
      readMBps: mb / (readMs / 1000),
    };
  } finally {
    handle.close();
    await dir.removeEntry('throughput.bin').catch(() => undefined);
  }
}

export async function runBenchmarks(): Promise<{
  wasmInstantiateMsFor50MB: number | null;
  opfsWriteMBps: number | null;
  opfsReadMBps: number | null;
}> {
  let wasmInstantiateMsFor50MB: number | null = null;
  let opfsWriteMBps: number | null = null;
  let opfsReadMBps: number | null = null;

  try {
    wasmInstantiateMsFor50MB = await benchmarkWasmInstantiate();
  } catch {
    /* leave null */
  }
  try {
    const opfs = await benchmarkOpfs();
    opfsWriteMBps = opfs.writeMBps;
    opfsReadMBps = opfs.readMBps;
  } catch {
    /* OPFS unavailable on main thread or unsupported → leave null */
  }

  return { wasmInstantiateMsFor50MB, opfsWriteMBps, opfsReadMBps };
}
