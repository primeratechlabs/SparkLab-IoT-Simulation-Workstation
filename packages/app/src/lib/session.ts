import { getStorage } from './storage-client.js';

export interface SessionInfo {
  fsBackend: string;
  indexBackend: string;
  persisted: boolean;
}

let initPromise: Promise<SessionInfo> | null = null;

/** Initialize the storage worker exactly once, shared across UI tabs. */
export function ensureInit(): Promise<SessionInfo> {
  if (!initPromise) {
    initPromise = getStorage().init();
  }
  return initPromise;
}

export const SAMPLE_PACK_BASE_URL = '/fixtures/sample-toolchain';
export const TRUSTED_KEYS_URL = '/fixtures/trusted-keys.json';

export async function loadTrustedKeysHex(): Promise<string[]> {
  const res = await fetch(TRUSTED_KEYS_URL);
  if (!res.ok) throw new Error(`cannot load trusted keys (${res.status})`);
  const data = (await res.json()) as { publicKeys: string[] };
  return data.publicKeys;
}
