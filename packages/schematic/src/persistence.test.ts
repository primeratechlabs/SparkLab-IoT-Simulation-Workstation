import { describe, it, expect } from 'vitest';
import type { VirtualFs, FileData } from '@sparklab/opfs';
import { emptyDocument, newComponent } from './document.js';
import {
  saveProject,
  loadProject,
  listProjects,
  deleteProject,
  projectExists,
} from './persistence.js';

/** Minimal in-memory VirtualFs mirroring the real contract (list returns sorted basenames). */
class MemFs implements VirtualFs {
  readonly backend = 'indexeddb' as const;
  private files = new Map<string, Uint8Array>();
  async mkdirp(): Promise<void> {}
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(`${p}/`));
  }
  async writeFile(p: string, d: FileData): Promise<void> {
    this.files.set(
      p,
      typeof d === 'string'
        ? new TextEncoder().encode(d)
        : d instanceof ArrayBuffer
          ? new Uint8Array(d)
          : d,
    );
  }
  async readFile(p: string): Promise<Uint8Array> {
    const f = this.files.get(p);
    if (!f) throw new Error(`not found: ${p}`);
    return f;
  }
  async readFileText(p: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(p));
  }
  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const seg = k.slice(prefix.length).split('/')[0];
        if (seg) names.add(seg);
      }
    }
    return [...names].sort();
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async size(p: string): Promise<number> {
    return (await this.readFile(p)).byteLength;
  }
}

describe('persistence', () => {
  it('saves and loads a document round-trip', async () => {
    const fs = new MemFs();
    const doc = emptyDocument('p1', 'My circuit', { now: 10 });
    doc.components.push(newComponent('led1', 'led', 5, 5));
    await saveProject(fs, doc);
    expect(await loadProject(fs, 'p1')).toEqual(doc);
  });

  it('saveProject stamps modifiedAt when given a clock', async () => {
    const fs = new MemFs();
    const doc = emptyDocument('p1', 'c', { now: 10 });
    const stored = await saveProject(fs, doc, { now: 555 });
    expect(stored.modifiedAt).toBe(555);
    expect((await loadProject(fs, 'p1')).modifiedAt).toBe(555);
  });

  it('lists projects newest-first and ignores foreign files', async () => {
    const fs = new MemFs();
    await saveProject(fs, emptyDocument('old', 'Old', { now: 100 }), { now: 100 });
    await saveProject(fs, emptyDocument('new', 'New', { now: 200 }), { now: 200 });
    await fs.writeFile('/projects/readme.txt', 'not a project');
    await fs.writeFile('/projects/broken.json', '{ not valid');

    const list = await listProjects(fs);
    expect(list.map((p) => p.id)).toEqual(['new', 'old']); // newest first
    expect(list.every((p) => p.name.length > 0)).toBe(true);
  });

  it('returns an empty list when nothing is saved', async () => {
    expect(await listProjects(new MemFs())).toEqual([]);
  });

  it('deletes a project', async () => {
    const fs = new MemFs();
    await saveProject(fs, emptyDocument('p1', 'c', { now: 0 }));
    expect(await projectExists(fs, 'p1')).toBe(true);
    await deleteProject(fs, 'p1');
    expect(await projectExists(fs, 'p1')).toBe(false);
    await deleteProject(fs, 'p1'); // idempotent
  });
});
