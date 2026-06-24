import { describe, it, expect } from 'vitest';
import type { VirtualFs, FileData } from '@sparklab/opfs';
import { EditorSession } from './session.js';
import { loadProject } from './persistence.js';
import { MCU_REF } from './types.js';

/** Monotonic clock so modifiedAt changes per edit. */
function clock(): () => number {
  let t = 0;
  return () => ++t;
}

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
  async list(): Promise<string[]> {
    return [];
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async size(p: string): Promise<number> {
    return (await this.readFile(p)).byteLength;
  }
}

describe('EditorSession — editing', () => {
  it('generates sequential component ids and stamps modifiedAt', () => {
    const s = EditorSession.create('p', 'c', { now: clock() });
    expect(s.document.board.id).toBe('arduino-uno');
    expect(s.addComponent('led', 10, 20)).toBe('led1');
    expect(s.addComponent('led', 0, 0)).toBe('led2');
    expect(s.document.components).toHaveLength(2);
    expect(s.document.modifiedAt).toBeGreaterThan(s.document.createdAt);
  });

  it('targets a chosen board', () => {
    const s = EditorSession.create('p', 'c', { boardId: 'esp32-c3-devkitm', now: clock() });
    expect(s.document.board.id).toBe('esp32-c3-devkitm');
  });

  it('connect validates endpoints, rejecting self/dangling/duplicate', () => {
    const s = EditorSession.create('p', 'c', { now: clock() });
    s.addComponent('led', 0, 0); // led1
    s.addComponent('resistor', 0, 0); // resistor1
    expect(
      s.connect({ component: 'led1', pin: 'anode' }, { component: 'resistor1', pin: 'a' }),
    ).toBe('w1');
    expect(
      s.connect({ component: 'led1', pin: 'anode' }, { component: 'resistor1', pin: 'a' }),
    ).toBeUndefined(); // duplicate
    expect(
      s.connect({ component: 'led1', pin: 'anode' }, { component: 'led1', pin: 'anode' }),
    ).toBeUndefined(); // self
    expect(
      s.connect({ component: 'ghost', pin: 'x' }, { component: 'resistor1', pin: 'a' }),
    ).toBeUndefined(); // dangling
    expect(s.document.wires).toHaveLength(1);
  });

  it('undo/redo through edits', () => {
    const s = EditorSession.create('p', 'c', { now: clock() });
    s.addComponent('led', 0, 0);
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.document.components).toHaveLength(0);
    s.redo();
    expect(s.document.components).toHaveLength(1);
  });
});

describe('EditorSession — analysis', () => {
  it('surfaces structural + electrical problems', () => {
    const s = EditorSession.create('p', 'c', { now: clock() });
    s.addComponent('led', 0, 0); // led1, no resistor
    s.connect({ component: 'led1', pin: 'anode' }, { component: MCU_REF, pin: 'D13' });
    s.connect({ component: 'led1', pin: 'cathode' }, { component: MCU_REF, pin: 'GND' });
    const probs = s.problems();
    expect(probs.structural).toHaveLength(0);
    expect(probs.electrical.some((f) => f.rule === 'led-no-resistor')).toBe(true);
  });
});

describe('EditorSession — notification + persistence', () => {
  it('notifies subscribers on real changes only', () => {
    const s = EditorSession.create('p', 'c', { now: clock() });
    let fired = 0;
    const unsub = s.subscribe(() => fired++);
    s.addComponent('led', 0, 0);
    expect(fired).toBe(1);
    s.moveComponent('ghost', 1, 1); // no-op
    expect(fired).toBe(1);
    unsub();
    s.addComponent('led', 0, 0);
    expect(fired).toBe(1); // unsubscribed
  });

  it('saves and reloads the current document', async () => {
    const fs = new MemFs();
    const s = EditorSession.create('p1', 'My circuit', { now: clock() });
    s.addComponent('led', 5, 5);
    await s.save(fs);
    expect(await loadProject(fs, 'p1')).toEqual(s.document);
  });

  it('replace swaps the document (last-write-wins) and notifies', () => {
    const s = EditorSession.create('p', 'c', { now: clock() });
    s.addComponent('led', 0, 0);
    let fired = 0;
    s.subscribe(() => fired++);
    const remote = EditorSession.create('p', 'c', { now: clock() });
    remote.addComponent('button', 0, 0);
    s.replace(remote.document);
    expect(s.document.components.map((c) => c.type)).toEqual(['button']);
    expect(fired).toBe(1);
  });
});
