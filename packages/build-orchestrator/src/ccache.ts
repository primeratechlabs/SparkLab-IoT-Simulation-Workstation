/**
 * Browser ccache — REFERENCE-SPEC §11/§36, invariant I5. Objects are content-
 * addressed by ObjectCacheKeyInput (compiler + flags + target + source + header
 * hashes + sdk/library hashes). Stored at build/objects/<sha>.o in OPFS with the
 * key recorded in the build index, so reload reuses without recompiling.
 */

import type { ObjectCacheKeyInput, Sha256 } from '@sparklab/shared';
import { objectCacheKey, bareHash } from '@sparklab/shared';
import { type VirtualFs, type BuildIndex, objectPath, selectLruEvictions } from '@sparklab/opfs';

export interface CacheHit {
  objectKey: Sha256;
  object: Uint8Array;
}

/** 64 MB default object-cache budget; evicted objects are simply recompiled on the next build. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class ObjectCache {
  constructor(
    private readonly fs: VirtualFs,
    private readonly index: BuildIndex,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  keyFor(input: ObjectCacheKeyInput): Promise<Sha256> {
    return objectCacheKey(input);
  }

  async lookup(input: ObjectCacheKeyInput): Promise<CacheHit | null> {
    const objectKey = await objectCacheKey(input);
    const rec = await this.index.getObject(objectKey);
    if (!rec) return null;
    if (!(await this.fs.exists(rec.path))) return null; // index/disk drift → miss
    await this.index.touchObject(objectKey, this.now()); // LRU: a hit is a recent use
    return { objectKey, object: await this.fs.readFile(rec.path) };
  }

  async store(input: ObjectCacheKeyInput, object: Uint8Array): Promise<Sha256> {
    const objectKey = await objectCacheKey(input);
    const path = objectPath(bareHash(objectKey));
    await this.fs.writeFile(path, object);
    await this.index.putObject(objectKey, {
      path,
      sizeBytes: object.length,
      lastUsedAt: this.now(),
    });
    await this.enforceCap(objectKey);
    return objectKey;
  }

  /**
   * Evict least-recently-used objects until the cache fits `maxBytes`. Evicting an object is
   * safe: a later build that needs it simply misses and recompiles that one unit (the firmware
   * key is unchanged — reproducible). Never evicts `keep` (the object just stored).
   */
  async enforceCap(keep?: Sha256): Promise<{ evicted: string[]; freedBytes: number }> {
    const entries = await this.index.listObjects();
    const total = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    if (total <= this.maxBytes) return { evicted: [], freedBytes: 0 };

    const victims = selectLruEvictions(
      entries
        .filter((e) => e.objectKey !== keep)
        .map((e) => ({ key: e.objectKey, sizeBytes: e.sizeBytes, lastUsedAt: e.lastUsedAt })),
      total - this.maxBytes,
    );
    let freed = 0;
    for (const key of victims) {
      const rec = await this.index.getObject(key);
      if (rec) {
        freed += rec.sizeBytes;
        await this.fs.remove(rec.path).catch(() => {}); // tolerate an already-gone file
      }
      await this.index.deleteObject(key);
    }
    return { evicted: victims, freedBytes: freed };
  }
}
