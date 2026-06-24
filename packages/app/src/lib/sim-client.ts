import * as Comlink from 'comlink';
import SimWorker from '../workers/sim.worker?worker';
import type { SimWorkerApi } from '../workers/sim.worker';

let remote: Comlink.Remote<SimWorkerApi> | null = null;

export function getSim(): Comlink.Remote<SimWorkerApi> {
  if (!remote) {
    const worker = new SimWorker({ name: 'sparklab-sim' });
    worker.onerror = (e) =>
      console.error('[sparklab] sim worker error:', (e as ErrorEvent).message || e);
    worker.onmessageerror = (e) => console.error('[sparklab] sim worker message error:', e);
    remote = Comlink.wrap<SimWorkerApi>(worker);
    (globalThis as { __sparklabSim?: unknown }).__sparklabSim = remote;
  }
  return remote;
}
