/**
 * Pack registry — system/pack-registry.json (REFERENCE-SPEC §10). A small,
 * human-inspectable record of which packs are installed, mirroring the SQLite
 * index. Reads/writes are serialized cross-tab via Web Locks.
 */

import { type VirtualFs, OPFS_LAYOUT, withLock, LOCK_NAMES } from '@sparklab/opfs';

export interface RegistryEntry {
  name: string;
  version: string;
  packType: string;
  sizeBytes: number;
  installedAt: number;
}

export interface PackRegistry {
  version: 1;
  packs: RegistryEntry[];
}

const EMPTY: PackRegistry = { version: 1, packs: [] };

function key(e: { name: string; version: string }): string {
  return `${e.name}@${e.version}`;
}

export async function readRegistry(fs: VirtualFs): Promise<PackRegistry> {
  try {
    if (!(await fs.exists(OPFS_LAYOUT.system.packRegistry))) return { ...EMPTY };
    const text = await fs.readFileText(OPFS_LAYOUT.system.packRegistry);
    const parsed = JSON.parse(text) as PackRegistry;
    if (parsed.version !== 1 || !Array.isArray(parsed.packs)) return { ...EMPTY };
    return parsed;
  } catch {
    return { ...EMPTY };
  }
}

async function writeRegistry(fs: VirtualFs, reg: PackRegistry): Promise<void> {
  await fs.mkdirp(OPFS_LAYOUT.system.dir);
  await fs.writeFile(OPFS_LAYOUT.system.packRegistry, JSON.stringify(reg, null, 2));
}

export async function registryUpsert(fs: VirtualFs, entry: RegistryEntry): Promise<void> {
  await withLock(LOCK_NAMES.registry, async () => {
    const reg = await readRegistry(fs);
    const next = reg.packs.filter((p) => key(p) !== key(entry));
    next.push(entry);
    next.sort((a, b) => key(a).localeCompare(key(b)));
    await writeRegistry(fs, { version: 1, packs: next });
  });
}

export async function registryRemove(fs: VirtualFs, name: string, version: string): Promise<void> {
  await withLock(LOCK_NAMES.registry, async () => {
    const reg = await readRegistry(fs);
    await writeRegistry(fs, {
      version: 1,
      packs: reg.packs.filter((p) => key(p) !== key({ name, version })),
    });
  });
}
