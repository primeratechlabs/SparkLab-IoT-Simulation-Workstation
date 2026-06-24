import { describe, it, expect } from 'vitest';
import { MemoryFs, MemoryBuildIndex } from './memory.js';
import type { InstalledPackRecord } from './index-db.js';

describe('MemoryFs root/empty-path handling', () => {
  it('list("") returns top-level entries', async () => {
    const fs = new MemoryFs();
    await fs.writeFile('a.txt', 'a');
    await fs.writeFile('dir/b.txt', 'b');
    await fs.writeFile('dir/sub/c.txt', 'c');
    // Top-level keys don't start with '/'; the old '/' prefix matched nothing.
    expect(await fs.list('')).toEqual(['a.txt', 'dir']);
  });

  it('list on a nested dir excludes deeper entries', async () => {
    const fs = new MemoryFs();
    await fs.writeFile('dir/b.txt', 'b');
    await fs.writeFile('dir/sub/c.txt', 'c');
    await fs.writeFile('dir/sub/deep/d.txt', 'd');
    expect(await fs.list('dir')).toEqual(['b.txt', 'sub']);
    expect(await fs.list('dir/sub')).toEqual(['c.txt', 'deep']);
  });

  it('exists("") is true (root always exists)', async () => {
    const fs = new MemoryFs();
    expect(await fs.exists('')).toBe(true);
    await fs.writeFile('a.txt', 'a');
    expect(await fs.exists('')).toBe(true);
  });
});

function pack(name: string, version: string): InstalledPackRecord {
  return {
    name,
    version,
    packType: 'sdk',
    manifestHash: `h-${name}-${version}`,
    sizeBytes: 1,
    installedAt: 0,
  };
}

describe('MemoryBuildIndex.getInstalledPack version selection', () => {
  it('returns 1.2.10 over 1.2.9 (numeric, not lexicographic)', async () => {
    const idx = new MemoryBuildIndex();
    // Insert a lower version first so the old first-match/.find() (and string
    // sort) would pick the wrong record; numeric compare must still win.
    await idx.recordInstalledPack(pack('avr-libc', '1.2.9'));
    await idx.recordInstalledPack(pack('avr-libc', '1.2.10'));
    await idx.recordInstalledPack(pack('avr-libc', '1.2.2'));
    const latest = await idx.getInstalledPack('avr-libc');
    expect(latest?.version).toBe('1.2.10');
  });

  it('still honours an explicit version request', async () => {
    const idx = new MemoryBuildIndex();
    await idx.recordInstalledPack(pack('avr-libc', '1.2.10'));
    await idx.recordInstalledPack(pack('avr-libc', '1.2.9'));
    expect((await idx.getInstalledPack('avr-libc', '1.2.9'))?.version).toBe('1.2.9');
    expect(await idx.getInstalledPack('avr-libc', '9.9.9')).toBeNull();
  });
});
