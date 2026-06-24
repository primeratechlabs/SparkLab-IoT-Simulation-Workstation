/**
 * Streaming pack download with progress. Reads the fetch ReadableStream so large
 * packs don't buffer twice and we can report byte-level progress to the UI.
 */

export interface ProgressInfo {
  receivedBytes: number;
  totalBytes: number | null;
  fraction: number | null;
}

export type ProgressCallback = (p: ProgressInfo) => void;

/**
 * Default hard ceiling for a single downloaded artifact. Toolchain packs are the largest thing we fetch
 * (~100 MB compressed); 512 MiB leaves generous headroom while bounding peak memory so a mis-sized or
 * hostile origin can't drive the tab into an out-of-memory crash (AUD-016).
 */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export interface DownloadLimits {
  /** Reject the download (before and during streaming) once it would exceed this many bytes. */
  maxBytes?: number;
}

/** A download was refused because it exceeds the configured size cap — distinguishable from a network error. */
export class PackSizeError extends Error {
  constructor(
    readonly url: string,
    readonly limit: number,
    readonly declared: number | null,
  ) {
    super(
      declared !== null
        ? `pack too large: ${declared} bytes declared for ${url} exceeds limit ${limit}`
        : `pack too large: ${url} exceeded the ${limit}-byte limit while downloading`,
    );
    this.name = 'PackSizeError';
  }
}

export async function downloadBytes(
  url: string,
  onProgress?: ProgressCallback,
  init?: RequestInit,
  limits?: DownloadLimits,
): Promise<Uint8Array> {
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);

  const lenHeader = res.headers.get('content-length');
  const totalBytes = lenHeader ? Number(lenHeader) : null;
  // Pre-allocation guard: a trustworthy Content-Length over the cap is rejected before we read a byte.
  if (totalBytes !== null && Number.isFinite(totalBytes) && totalBytes > maxBytes) {
    throw new PackSizeError(url, maxBytes, totalBytes);
  }

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new PackSizeError(url, maxBytes, buf.length);
    onProgress?.({ receivedBytes: buf.length, totalBytes: buf.length, fraction: 1 });
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.length;
      // Enforce during streaming too: Content-Length can be absent or lie, so cap the running total.
      if (received > maxBytes) {
        await reader.cancel().catch(() => {}); // stop the body; don't keep buffering
        throw new PackSizeError(url, maxBytes, totalBytes);
      }
      chunks.push(value);
      onProgress?.({
        receivedBytes: received,
        totalBytes,
        fraction: totalBytes ? received / totalBytes : null,
      });
    }
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function downloadJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  return (await res.json()) as T;
}
