import { describe, it, expect } from 'vitest';
import { MemoryFs, MemoryBuildIndex } from '@sparklab/opfs';
import type { ObjectCacheKeyInput } from '@sparklab/shared';
import { ObjectCache } from './ccache.js';

const enc = new TextEncoder();

function keyInput(over: Partial<ObjectCacheKeyInput> = {}): ObjectCacheKeyInput {
  return {
    compilerId: 'stub-cc@1',
    compilerFlags: ['-O0'],
    targetTriple: 'avr-atmega328p',
    sourceHash: 'sha256:src',
    includedHeaderHashes: ['sha256:h1'],
    sdkPackHash: 'sha256:sdk',
    libraryPackHash: 'sha256:lib',
    ...over,
  };
}

describe('ObjectCache', () => {
  it('store then lookup hits and returns identical bytes', async () => {
    const fs = new MemoryFs();
    const cache = new ObjectCache(fs, new MemoryBuildIndex());
    const obj = enc.encode('object-bytes');
    const key = await cache.store(keyInput(), obj);

    const hit = await cache.lookup(keyInput());
    expect(hit).not.toBeNull();
    expect(hit!.objectKey).toBe(key);
    expect(Array.from(hit!.object)).toEqual(Array.from(obj));
  });

  it('different inputs miss', async () => {
    const cache = new ObjectCache(new MemoryFs(), new MemoryBuildIndex());
    await cache.store(keyInput(), enc.encode('x'));
    expect(await cache.lookup(keyInput({ sourceHash: 'sha256:other' }))).toBeNull();
  });

  it('index/disk drift (file deleted) is treated as a miss', async () => {
    const fs = new MemoryFs();
    const index = new MemoryBuildIndex();
    const cache = new ObjectCache(fs, index);
    await cache.store(keyInput(), enc.encode('x'));
    fs.files.clear(); // simulate disk loss
    expect(await cache.lookup(keyInput())).toBeNull();
  });
});

describe('ObjectCache — LRU eviction (Stage 7)', () => {
  const TEN = new TextEncoder().encode('0123456789'); // 10-byte objects; cap holds 3

  it('evicts the least-recently-used object when over the size cap', async () => {
    const fs = new MemoryFs();
    const index = new MemoryBuildIndex();
    let t = 0;
    const cache = new ObjectCache(fs, index, 30, () => ++t);
    for (const h of ['a', 'b', 'c']) await cache.store(keyInput({ sourceHash: h }), TEN); // 30 B, fits
    await cache.store(keyInput({ sourceHash: 'd' }), TEN); // 40 B → over cap → evict oldest (a)

    expect(await cache.lookup(keyInput({ sourceHash: 'a' }))).toBeNull(); // evicted
    expect(await cache.lookup(keyInput({ sourceHash: 'b' }))).not.toBeNull();
    expect(await cache.lookup(keyInput({ sourceHash: 'c' }))).not.toBeNull();
    expect(await cache.lookup(keyInput({ sourceHash: 'd' }))).not.toBeNull();
    expect((await index.listObjects()).length).toBe(3); // capped
  });

  it('a cache hit refreshes LRU order so the touched object survives', async () => {
    const fs = new MemoryFs();
    const index = new MemoryBuildIndex();
    let t = 0;
    const cache = new ObjectCache(fs, index, 30, () => ++t);
    for (const h of ['a', 'b', 'c']) await cache.store(keyInput({ sourceHash: h }), TEN);
    await cache.lookup(keyInput({ sourceHash: 'a' })); // touch a → newest
    await cache.store(keyInput({ sourceHash: 'd' }), TEN); // over cap → evict now-oldest (b)

    expect(await cache.lookup(keyInput({ sourceHash: 'a' }))).not.toBeNull(); // survived
    expect(await cache.lookup(keyInput({ sourceHash: 'b' }))).toBeNull(); // evicted
  });

  it('an evicted object is simply recompiled/re-stored on the next build (graceful miss)', async () => {
    const fs = new MemoryFs();
    const index = new MemoryBuildIndex();
    let t = 0;
    const cache = new ObjectCache(fs, index, 30, () => ++t);
    for (const h of ['a', 'b', 'c', 'd']) await cache.store(keyInput({ sourceHash: h }), TEN); // a evicted
    expect(await cache.lookup(keyInput({ sourceHash: 'a' }))).toBeNull();

    await cache.store(keyInput({ sourceHash: 'a' }), TEN); // "recompiled" and re-stored
    expect(await cache.lookup(keyInput({ sourceHash: 'a' }))).not.toBeNull(); // cached again
  });

  it('does not evict when under the cap', async () => {
    const fs = new MemoryFs();
    const index = new MemoryBuildIndex();
    const cache = new ObjectCache(fs, index, 1_000_000);
    for (const h of ['a', 'b', 'c']) await cache.store(keyInput({ sourceHash: h }), TEN);
    expect((await index.listObjects()).length).toBe(3); // nothing evicted
  });
});
