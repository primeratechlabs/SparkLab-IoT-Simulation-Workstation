import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveProject,
  loadProject,
  clearProject,
  PROJECT_VERSION,
  type SavedCanvas,
} from './persist';

describe('persist — localStorage autosave (AUD-001)', () => {
  beforeEach(() => clearProject());

  it('round-trips a project WITH its circuit, versioned, and clears it', () => {
    expect(loadProject()).toBeNull();
    const canvas: SavedCanvas = {
      placed: [
        {
          cid: 'led1',
          type: 'led',
          tag: 'wokwi-led',
          x: 100,
          y: 50,
          rot: 90,
          flip: false,
          props: { color: 'red' },
        },
      ],
      wires: [
        { id: 'w1', from: { cid: 'led1', pin: 'A' }, to: { cid: 'BOARD', pin: 'D13' }, points: [] },
      ],
      boardPos: { x: 40, y: 150 },
      boardRot: 0,
    };
    const p = {
      boardId: 'arduino-uno',
      name: 'blink',
      sketch: 'void setup(){}\nvoid loop(){}',
      canvas,
    };
    expect(saveProject(p)).toBe(true);
    const out = loadProject();
    expect(out).toEqual({ version: PROJECT_VERSION, ...p }); // sketch AND circuit restored together
    clearProject();
    expect(loadProject()).toBeNull();
  });

  it('migrates a v1 (sketch-only) entry — opens with an empty circuit, never crashes', () => {
    // a pre-AUD-001 saved project: no version, no canvas
    localStorage.setItem(
      'sparklab:project',
      JSON.stringify({ boardId: 'arduino-uno', name: 'old', sketch: 'x' }),
    );
    const out = loadProject();
    expect(out).toEqual({
      version: 1,
      boardId: 'arduino-uno',
      name: 'old',
      sketch: 'x',
      canvas: null,
    });
  });

  it('drops a malformed canvas but keeps the sketch', () => {
    localStorage.setItem(
      'sparklab:project',
      JSON.stringify({ boardId: 'uno', name: 'n', sketch: 's', canvas: { placed: 'nope' } }),
    );
    expect(loadProject()?.canvas).toBeNull();
  });

  it('ignores corrupt or wrong-shaped entries', () => {
    localStorage.setItem('sparklab:project', '{ not json');
    expect(loadProject()).toBeNull();
    localStorage.setItem('sparklab:project', JSON.stringify({ boardId: 1, name: 'x' }));
    expect(loadProject()).toBeNull();
  });
});
