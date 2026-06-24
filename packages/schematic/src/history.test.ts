import { describe, it, expect } from 'vitest';
import { EditorHistory } from './history.js';
import { emptyDocument, newComponent } from './document.js';
import { addComponent, moveComponent } from './commands.js';

const start = () => emptyDocument('p', 'c', { now: 0 });

describe('EditorHistory', () => {
  it('apply advances current and enables undo', () => {
    const h = new EditorHistory(start());
    expect(h.canUndo).toBe(false);
    h.apply((d) => addComponent(d, newComponent('led1', 'led', 0, 0)));
    expect(h.current.components).toHaveLength(1);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
  });

  it('undo restores the prior state and redo reapplies', () => {
    const h = new EditorHistory(start());
    h.apply((d) => addComponent(d, newComponent('led1', 'led', 0, 0)));
    h.apply((d) => moveComponent(d, 'led1', 50, 60));
    expect(h.current.components[0]).toMatchObject({ x: 50, y: 60 });

    h.undo();
    expect(h.current.components[0]).toMatchObject({ x: 0, y: 0 });
    h.undo();
    expect(h.current.components).toHaveLength(0);

    h.redo();
    expect(h.current.components).toHaveLength(1);
    expect(h.canRedo).toBe(true);
  });

  it('a new edit after undo clears the redo stack', () => {
    const h = new EditorHistory(start());
    h.apply((d) => addComponent(d, newComponent('a', 'led', 0, 0)));
    h.apply((d) => addComponent(d, newComponent('b', 'led', 0, 0)));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.apply((d) => addComponent(d, newComponent('c', 'led', 0, 0)));
    expect(h.canRedo).toBe(false);
    expect(h.current.components.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('a no-op transform (same reference) records nothing', () => {
    const h = new EditorHistory(start());
    h.apply((d) => moveComponent(d, 'ghost', 1, 1)); // unknown id → same ref
    expect(h.canUndo).toBe(false);
  });

  it('respects maxDepth, dropping the oldest states', () => {
    const h = new EditorHistory(start(), { maxDepth: 2 });
    for (let i = 0; i < 5; i++) h.apply((d) => addComponent(d, newComponent(`c${i}`, 'led', i, i)));
    let depth = 0;
    while (h.canUndo) {
      h.undo();
      depth++;
    }
    expect(depth).toBe(2); // only the last 2 states are retained
  });

  it('replace swaps the document outright (last-write-wins) but stays undoable', () => {
    const h = new EditorHistory(start());
    h.apply((d) => addComponent(d, newComponent('led1', 'led', 0, 0)));
    const remote = addComponent(start(), newComponent('remote', 'button', 0, 0));
    h.replace(remote);
    expect(h.current.components.map((c) => c.id)).toEqual(['remote']);
    h.undo();
    expect(h.current.components.map((c) => c.id)).toEqual(['led1']);
  });
});
