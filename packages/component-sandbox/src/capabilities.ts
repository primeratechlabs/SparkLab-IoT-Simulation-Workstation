/**
 * Capability restriction — REFERENCE-SPEC Stage 3 sandbox (gate #6). A component runs
 * with NO ambient authority: no network, no DOM, no persistent storage. Before any
 * component code runs in its Worker, `lockdownScope` strips these globals from the
 * worker's global object; a component that reads them sees `undefined`, so it cannot
 * exfiltrate data or escape. Pure + scope-injectable so it unit-tests without a Worker.
 */

/** Globals a component must never reach (network / storage / dynamic code / DOM). */
export const FORBIDDEN_GLOBALS = [
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
  'navigator', // navigator.storage (OPFS), navigator.serviceWorker, …
  'document',
  'localStorage',
  'sessionStorage',
] as const;

/**
 * Remove forbidden globals from a worker-like scope (e.g. `self`). Returns the names
 * that were present and have been neutralised. Best-effort: read-only globals are
 * overwritten where possible and otherwise reported as still-present by `auditScope`.
 */
export function lockdownScope(scope: Record<string, unknown>): string[] {
  const removed: string[] = [];
  for (const name of FORBIDDEN_GLOBALS) {
    if (name in scope && scope[name] !== undefined) {
      try {
        Object.defineProperty(scope, name, {
          value: undefined,
          configurable: true,
          writable: false,
        });
        removed.push(name);
      } catch {
        try {
          scope[name] = undefined;
          removed.push(name);
        } catch {
          /* non-configurable, non-writable — reported by auditScope */
        }
      }
    }
  }
  return removed;
}

/** Names from FORBIDDEN_GLOBALS still reachable in the scope (should be empty post-lockdown). */
export function auditScope(scope: Record<string, unknown>): string[] {
  return FORBIDDEN_GLOBALS.filter((name) => scope[name] !== undefined);
}
