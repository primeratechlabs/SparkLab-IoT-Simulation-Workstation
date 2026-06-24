import { describe, it, expect, afterEach, vi } from 'vitest';
import { downloadBytes, PackSizeError } from './download.js';

/** Build a fake fetch Response whose body streams `chunks`, with an optional Content-Length header. */
function streamResponse(chunks: Uint8Array[], contentLength: number | null): Response {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers();
  if (contentLength !== null) headers.set('content-length', String(contentLength));
  const res = new Response(body, { status: 200, headers });
  // Expose whether the consumer cancelled the stream (the size-cap path must).
  (res as unknown as { _cancelled: () => boolean })._cancelled = () => cancelled;
  return res;
}

const orig = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = orig;
});

describe('downloadBytes — size cap (AUD-016)', () => {
  it('rejects before reading when Content-Length exceeds the cap', async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse([new Uint8Array(10)], 10_000),
    ) as typeof fetch;
    await expect(
      downloadBytes('http://x/pack.zst', undefined, undefined, { maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(PackSizeError);
  });

  it('rejects mid-stream when the running total exceeds the cap (lying/absent Content-Length)', async () => {
    const chunks = [new Uint8Array(600), new Uint8Array(600)]; // 1200 total, no Content-Length
    globalThis.fetch = vi.fn(async () => streamResponse(chunks, null)) as typeof fetch;
    await expect(
      downloadBytes('http://x/pack.zst', undefined, undefined, { maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(PackSizeError);
  });

  it('returns the bytes and reports progress for a download under the cap', async () => {
    const chunks = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)];
    globalThis.fetch = vi.fn(async () => streamResponse(chunks, 5)) as typeof fetch;
    const seen: number[] = [];
    const out = await downloadBytes(
      'http://x/pack.zst',
      (p) => seen.push(p.receivedBytes),
      undefined,
      {
        maxBytes: 1000,
      },
    );
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([3, 5]); // cumulative progress per chunk
  });
});
