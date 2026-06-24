/**
 * Cross-tab write serialization via the Web Locks API (invariant I6 / storage).
 * Prevents two tabs of the same origin from corrupting OPFS / the SQLite index.
 * Falls back to an in-process mutex when Web Locks is unavailable.
 */

// One serialization chain per lock name. The map holds the current tail; entries
// are pruned once no one is queued behind them (no unbounded growth).
const inProcessChains = new Map<string, Promise<void>>();

function inProcessLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = inProcessChains.get(name) ?? Promise.resolve();
  const result = prev.then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  inProcessChains.set(name, tail);
  void tail.then(() => {
    if (inProcessChains.get(name) === tail) inProcessChains.delete(name);
  });
  return result;
}

interface LockManagerLike {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

function webLocks(): LockManagerLike | null {
  const nav = globalThis.navigator as (Navigator & { locks?: LockManagerLike }) | undefined;
  return nav?.locks ?? null;
}

/** Run `fn` while holding an exclusive named lock; releases on settle. */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (locks) {
    return locks.request(name, fn);
  }
  return inProcessLock(name, fn);
}

export const LOCK_NAMES = {
  packInstall: 'sparklab:pack-install',
  buildIndex: 'sparklab:build-index',
  registry: 'sparklab:pack-registry',
} as const;
