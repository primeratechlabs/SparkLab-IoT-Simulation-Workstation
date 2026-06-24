import { describe, it, expect, vi } from 'vitest';
import { useAppView } from './useAppView';
import type { SavedProject } from '../lib/persist';

const sample: SavedProject = {
  boardId: 'arduino-uno',
  name: 'p',
  sketch: 'void setup(){}',
  canvas: null,
};

describe('useAppView — top-level navigation state machine (AUD-002)', () => {
  it('first visit (no saved project) lands on Start with no project', () => {
    const nav = useAppView({ load: () => null });
    expect(nav.view.value).toBe('start');
    expect(nav.hasProject()).toBe(false);
  });

  it('reload with a saved project resumes straight into the Workspace', () => {
    const nav = useAppView({ load: () => sample });
    expect(nav.view.value).toBe('workspace');
    expect(nav.project.value).toEqual(sample);
  });

  it('?view=labs deep-links to Labs without restoring a project', () => {
    const load = vi.fn(() => sample);
    const nav = useAppView({ isLabs: true, load });
    expect(nav.view.value).toBe('labs');
    expect(load).not.toHaveBeenCalled(); // no restore on the labs deep-link
  });

  it('createProject persists, sets the project, and opens the Workspace', () => {
    const save = vi.fn();
    const nav = useAppView({ load: () => null, save });
    nav.createProject({ boardId: 'arduino-uno', name: 'blink', sketch: 's', canvas: null });
    expect(save).toHaveBeenCalledOnce();
    expect(nav.view.value).toBe('workspace');
    expect(nav.project.value).toMatchObject({ boardId: 'arduino-uno', name: 'blink' });
  });

  it('Back from Labs returns to the WORKSPACE when Labs was opened from the workspace', () => {
    const nav = useAppView({ load: () => sample }); // starts in workspace
    nav.openLabs();
    expect(nav.view.value).toBe('labs');
    nav.closeLabs();
    expect(nav.view.value).toBe('workspace'); // not dumped back to Start
  });

  it('Back from Labs returns to START when Labs was opened from Start', () => {
    const nav = useAppView({ load: () => null }); // starts on Start
    nav.openLabs();
    nav.closeLabs();
    expect(nav.view.value).toBe('start');
  });

  it('resume() from Start re-opens the in-memory project', () => {
    const nav = useAppView({ load: () => sample });
    nav.goStart();
    expect(nav.view.value).toBe('start');
    expect(nav.hasProject()).toBe(true); // project still held → Resume is offered
    nav.resume();
    expect(nav.view.value).toBe('workspace');
  });

  it('resume() is a no-op when there is no project to resume', () => {
    const nav = useAppView({ load: () => null });
    nav.resume();
    expect(nav.view.value).toBe('start');
  });
});
