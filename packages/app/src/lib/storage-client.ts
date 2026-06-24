import * as Comlink from 'comlink';
import StorageWorker from '../workers/storage.worker?worker';
import type { StorageWorkerApi } from '../workers/storage.worker';

let remote: Comlink.Remote<StorageWorkerApi> | null = null;

/** Lazily spawn the single storage/daemon worker and wrap it with Comlink. */
export function getStorage(): Comlink.Remote<StorageWorkerApi> {
  if (!remote) {
    const worker = new StorageWorker({ name: 'sparklab-storage' });
    remote = Comlink.wrap<StorageWorkerApi>(worker);
    // Expose for e2e harness (read-only handle to the same Comlink remote).
    (globalThis as { __sparklab?: unknown }).__sparklab = remote;
  }
  return remote;
}

/** Wrap a progress callback so it can cross the worker boundary. */
export function proxyCallback<T extends (...args: never[]) => void>(fn: T): T {
  return Comlink.proxy(fn) as unknown as T;
}
