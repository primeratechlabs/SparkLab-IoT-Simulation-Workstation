/**
 * Storage quota management — request persistence, estimate usage, warn near the
 * cap, and a generic LRU eviction helper used by pack-manager / build cache.
 */

export interface QuotaStatus {
  usageBytes: number | null;
  quotaBytes: number | null;
  usedFraction: number | null;
  persisted: boolean;
  nearLimit: boolean;
}

const NEAR_LIMIT_FRACTION = 0.9;

export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getQuotaStatus(): Promise<QuotaStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {
      usageBytes: null,
      quotaBytes: null,
      usedFraction: null,
      persisted: false,
      nearLimit: false,
    };
  }
  const est = await navigator.storage.estimate();
  const usageBytes = typeof est.usage === 'number' ? est.usage : null;
  const quotaBytes = typeof est.quota === 'number' ? est.quota : null;
  const usedFraction =
    usageBytes != null && quotaBytes != null && quotaBytes > 0 ? usageBytes / quotaBytes : null;
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return {
    usageBytes,
    quotaBytes,
    usedFraction,
    persisted,
    nearLimit: usedFraction != null && usedFraction >= NEAR_LIMIT_FRACTION,
  };
}

export interface LruEntry {
  key: string;
  sizeBytes: number;
  lastUsedAt: number;
}

/**
 * Select least-recently-used entries to evict until `bytesToFree` is reached.
 * Pure helper (unit-testable); callers perform the actual deletion.
 */
export function selectLruEvictions(entries: LruEntry[], bytesToFree: number): string[] {
  if (bytesToFree <= 0) return [];
  const byOldest = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const victims: string[] = [];
  let freed = 0;
  for (const e of byOldest) {
    if (freed >= bytesToFree) break;
    victims.push(e.key);
    freed += e.sizeBytes;
  }
  return victims;
}
