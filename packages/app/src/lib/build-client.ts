import * as Comlink from 'comlink';
import BuildWorker from '../workers/build.worker?worker';
import type { BuildWorkerApi } from '../workers/build.worker';

let remote: Comlink.Remote<BuildWorkerApi> | null = null;

/** Lazily spawn the single build daemon worker and wrap it with Comlink. */
export function getBuild(): Comlink.Remote<BuildWorkerApi> {
  if (!remote) {
    const worker = new BuildWorker({ name: 'sparklab-build' });
    // A worker that fails to initialize (module-eval error, or a CSP worker-src rejection after a bad
    // deploy) never answers — Comlink calls then hang. We can't reject the in-flight RPC from here, but
    // surfacing the error makes it diagnosable; the compile await in useSimRunner has a timeout backstop.
    worker.onerror = (e) =>
      console.error('[sparklab] build worker error:', (e as ErrorEvent).message || e);
    worker.onmessageerror = (e) => console.error('[sparklab] build worker message error:', e);
    remote = Comlink.wrap<BuildWorkerApi>(worker);
    (globalThis as { __sparklabBuild?: unknown }).__sparklabBuild = remote;
  }
  return remote;
}
