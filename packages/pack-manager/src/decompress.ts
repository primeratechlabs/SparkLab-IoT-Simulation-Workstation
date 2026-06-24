/**
 * zstd decompression for pack payloads. Uses fzstd (pure-JS/WASM, decompress-only).
 * Streaming variant keeps peak memory bounded for large (≥50MB) toolchain packs.
 */

import { decompress as zstdDecompress, Decompress } from 'fzstd';

/** One-shot decompress of a complete zstd buffer. */
export function decompressZstd(compressed: Uint8Array): Uint8Array {
  return zstdDecompress(compressed);
}

/**
 * Streaming decompress: feed chunks (e.g. from a fetch ReadableStream) and collect
 * the inflated output. Concatenates output chunks at the end.
 */
export class ZstdStream {
  private chunks: Uint8Array[] = [];
  private total = 0;
  private readonly stream: Decompress;

  constructor() {
    this.stream = new Decompress((chunk) => {
      this.chunks.push(chunk);
      this.total += chunk.length;
    });
  }

  push(chunk: Uint8Array, last = false): void {
    this.stream.push(chunk, last);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

export async function decompressStreamingFrom(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Uint8Array> {
  const zs = new ZstdStream();
  const iterable = source as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  chunks.forEach((c, i) => zs.push(c, i === chunks.length - 1));
  return zs.finish();
}
