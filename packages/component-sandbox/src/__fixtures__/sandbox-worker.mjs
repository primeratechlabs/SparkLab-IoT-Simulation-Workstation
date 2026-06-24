/**
 * Real-Worker sandbox entry (Stage 7 abuse test). Runs in a genuine worker thread: it locks down
 * ambient authority (mirrors @sparklab/component-sandbox lockdownScope, which is unit-tested
 * separately), then handles work. `cmd:'loop'` never replies — a real infinite loop that only an
 * external terminate() can stop, exercising the watchdog against a truly-hung worker.
 */
import { parentPort } from 'node:worker_threads';

const FORBIDDEN = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebTransport',
  'EventSource',
  'importScripts',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'indexedDB',
  'caches',
  'navigator',
  'document',
  'localStorage',
  'sessionStorage',
];
for (const name of FORBIDDEN) {
  if (globalThis[name] !== undefined) {
    try {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        configurable: true,
        writable: false,
      });
    } catch {
      try {
        globalThis[name] = undefined;
      } catch {
        /* non-configurable */
      }
    }
  }
}

parentPort.on('message', (msg) => {
  switch (msg?.cmd) {
    case 'loop':
      for (;;) {
        /* never returns → the watchdog must terminate this worker */
      }
    case 'tryFetch':
      parentPort.postMessage({ fetchAvailable: globalThis.fetch !== undefined });
      return;
    case 'tryStorage':
      parentPort.postMessage({
        storageAvailable: globalThis.navigator !== undefined || globalThis.indexedDB !== undefined,
      });
      return;
    case 'echo':
      parentPort.postMessage({ echo: msg.value });
      return;
    default:
      parentPort.postMessage({ ok: true });
  }
});
