/**
 * Storage health: total pack footprint, persistence status, and detection of
 * packs that the index claims but whose files are missing on disk (graceful —
 * reports rather than throws, invariant I9).
 */

import {
  type VirtualFs,
  type BuildIndex,
  type InstalledPackRecord,
  packInstallPath,
  getQuotaStatus,
  type QuotaStatus,
} from '@sparklab/opfs';

export interface PackHealthEntry {
  name: string;
  version: string;
  packType: string;
  sizeBytes: number;
  present: boolean;
}

export interface StorageHealth {
  packCount: number;
  totalPackBytes: number;
  missing: PackHealthEntry[];
  packs: PackHealthEntry[];
  quota: QuotaStatus;
}

async function manifestPresent(fs: VirtualFs, rec: InstalledPackRecord): Promise<boolean> {
  const installPath = packInstallPath(rec.packType, rec.name, rec.version);
  return fs.exists(`${installPath}/manifest.json`);
}

export async function getStorageHealth(fs: VirtualFs, index: BuildIndex): Promise<StorageHealth> {
  const records = await index.listInstalledPacks();
  const packs: PackHealthEntry[] = [];
  let totalPackBytes = 0;

  for (const rec of records) {
    const present = await manifestPresent(fs, rec);
    totalPackBytes += rec.sizeBytes;
    packs.push({
      name: rec.name,
      version: rec.version,
      packType: rec.packType,
      sizeBytes: rec.sizeBytes,
      present,
    });
  }

  return {
    packCount: packs.length,
    totalPackBytes,
    missing: packs.filter((p) => !p.present),
    packs,
    quota: await getQuotaStatus(),
  };
}
