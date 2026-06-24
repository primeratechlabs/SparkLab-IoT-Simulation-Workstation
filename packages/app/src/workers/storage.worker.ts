/**
 * Storage/daemon worker (invariant I2 — all heavy work off the main thread).
 * Hosts: capability benchmarks (need a Worker for OPFS sync access handles), the
 * OPFS virtual filesystem, the SQLite-WASM build index, and the pack-manager
 * install/evict/health pipeline. Exposed to the UI via Comlink.
 */

import * as Comlink from 'comlink';
import type { CapabilityProfile } from '@sparklab/shared';
import { fromHex } from '@sparklab/shared';
import { collectCapabilityProfile, runBenchmarks } from '@sparklab/capability';
import {
  openFs,
  openBuildIndex,
  bootstrapDirs,
  requestPersistence,
  OPFS_LAYOUT,
  type VirtualFs,
  type BuildIndex,
} from '@sparklab/opfs';
import {
  installPack,
  evictPack,
  getStorageHealth,
  registryUpsert,
  registryRemove,
  HttpPackSource,
  type InstallProgress,
  type InstallResult,
  type StorageHealth,
} from '@sparklab/pack-manager';

const SAMPLE_PACK = { packType: 'toolchain', name: 'sample-toolchain', version: '1.0.0' } as const;

interface Ready {
  fs: VirtualFs;
  index: BuildIndex;
  fsBackend: string;
  indexBackend: string;
  persisted: boolean;
}

// Single initialization, awaited by EVERY method so call order never races
// (Comlink RPC calls can arrive before init() resolves).
let readyPromise: Promise<Ready> | null = null;

async function doInit(): Promise<Ready> {
  const fs = await openFs();
  const index = await openBuildIndex();
  for (const dir of bootstrapDirs()) await fs.mkdirp(dir);
  const persisted = await requestPersistence();
  return { fs, index, fsBackend: fs.backend, indexBackend: index.backend, persisted };
}

function ready(): Promise<Ready> {
  if (!readyPromise) readyPromise = doInit();
  return readyPromise;
}

const api = {
  async init(): Promise<{ fsBackend: string; indexBackend: string; persisted: boolean }> {
    const r = await ready();
    return { fsBackend: r.fsBackend, indexBackend: r.indexBackend, persisted: r.persisted };
  },

  async profile(): Promise<CapabilityProfile> {
    const { fs, index } = await ready();
    const benchmarks = await runBenchmarks();
    const profile = await collectCapabilityProfile({ benchmarks });
    // Persist the profile (system/capability-profile.json) and append to history.
    await fs.writeFile(OPFS_LAYOUT.system.capabilityProfile, JSON.stringify(profile, null, 2));
    await index.recordCapability(JSON.stringify(profile));
    return profile;
  },

  /** Last persisted capability snapshot (proves index persistence across reload). */
  async latestCapability(): Promise<CapabilityProfile | null> {
    const { index } = await ready();
    const snap = await index.latestCapability();
    return snap ? (JSON.parse(snap.json) as CapabilityProfile) : null;
  },

  /** Generic index probe for the SQLite/IndexedDB persistence gate. */
  async setProbe(value: string): Promise<void> {
    const { index } = await ready();
    await index.putProjectJson('probe', 'default', value);
  },
  async getProbe(): Promise<string | null> {
    const { index } = await ready();
    return index.getProjectJson('probe', 'default');
  },

  /** General install used by the UI and by e2e (e.g. to exercise forged packs). */
  async installFromUrl(
    baseUrl: string,
    trustedKeysHex: string[],
    knownPack: { packType: string; name: string; version: string },
    onProgress?: (p: InstallProgress) => void,
  ): Promise<InstallResult> {
    const { fs, index } = await ready();
    const trustedPublicKeys = trustedKeysHex.map((h) => fromHex(h));
    const source = new HttpPackSource(baseUrl);
    return installPack({
      source,
      fs,
      index,
      trustedPublicKeys,
      knownPack,
      onProgress: onProgress ? (p) => onProgress(p) : undefined,
    });
  },

  async installSamplePack(
    baseUrl: string,
    trustedKeysHex: string[],
    onProgress?: (p: InstallProgress) => void,
  ): Promise<InstallResult> {
    const { fs } = await ready();
    const result = await api.installFromUrl(baseUrl, trustedKeysHex, SAMPLE_PACK, onProgress);
    await registryUpsert(fs, {
      name: result.name,
      version: result.version,
      packType: SAMPLE_PACK.packType,
      sizeBytes: result.totalBytes,
      installedAt: Date.now(),
    });
    return result;
  },

  async health(): Promise<StorageHealth> {
    const { fs, index } = await ready();
    return getStorageHealth(fs, index);
  },

  async evictSamplePack(): Promise<void> {
    const { fs, index } = await ready();
    await evictPack({
      fs,
      index,
      packType: SAMPLE_PACK.packType,
      name: SAMPLE_PACK.name,
      version: SAMPLE_PACK.version,
    });
    await registryRemove(fs, SAMPLE_PACK.name, SAMPLE_PACK.version);
  },
};

export type StorageWorkerApi = typeof api;

Comlink.expose(api);
