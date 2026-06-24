/**
 * Evict an installed pack: remove its OPFS directory and its index row.
 * Idempotent — evicting an absent pack is a no-op.
 */

import {
  type VirtualFs,
  type BuildIndex,
  packInstallPath,
  withLock,
  LOCK_NAMES,
} from '@sparklab/opfs';

export interface EvictOptions {
  fs: VirtualFs;
  index: BuildIndex;
  packType: string;
  name: string;
  version: string;
}

export async function evictPack(opts: EvictOptions): Promise<void> {
  const { fs, index, packType, name, version } = opts;
  await withLock(LOCK_NAMES.packInstall, async () => {
    const installPath = packInstallPath(packType, name, version);
    await fs.remove(installPath);
    await index.removeInstalledPack(name, version);
  });
}
