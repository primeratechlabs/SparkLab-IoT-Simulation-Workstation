/**
 * Top-level view state machine (AUD-002). Three views — Start (board/template picker), Workspace (the
 * current project), and Advanced Labs — plus the transitions between them. Extracted from App.vue so the
 * navigation rules are unit-testable without mounting the heavy workspace (which pulls in build/sim workers).
 *
 * The key behaviours this encodes:
 *  - Reload resumes the autosaved project straight into the Workspace (no work lost).
 *  - Back from Labs returns to WHERE Labs was opened from (workspace ⇒ workspace, start ⇒ start) — not
 *    unconditionally to Start, which previously dropped the user out of their project.
 *  - Start offers Resume when a project is in memory, so leaving to Start is recoverable.
 */
import { ref, shallowRef } from 'vue';
import { defaultSketch, boardInfo } from '../lib/boards';
import { loadProject, saveProject, type SavedProject, type SavedCanvas } from '../lib/persist';

export type AppView = 'start' | 'workspace' | 'labs';

export interface CreateProjectInput {
  boardId: string;
  name?: string;
  sketch?: string;
  canvas?: SavedCanvas | null;
}

export interface AppViewOptions {
  /** Deep-link ?view=labs lands directly in Advanced Labs (no project restore). */
  isLabs?: boolean;
  load?: () => SavedProject | null; // injectable for tests
  save?: (p: SavedProject) => void;
}

export function useAppView(opts: AppViewOptions = {}) {
  const load = opts.load ?? loadProject;
  const save = opts.save ?? saveProject;
  const isLabs = opts.isLabs ?? false;

  // A restored project whose board is unknown or work-in-progress (e.g. the disabled ESP32-C3) must NOT
  // reopen the workspace — that bypasses the picker's wip gate and would pull the heavy, unfinished
  // toolchain. Drop it back to the Start screen instead (the saved entry lingers harmlessly and resumes
  // automatically once the board is enabled).
  const loaded = isLabs ? null : load();
  const board = loaded ? boardInfo(loaded.boardId) : undefined;
  const restored = loaded && board && !board.wip ? loaded : null;
  const project = shallowRef<SavedProject | null>(restored);
  const view = ref<AppView>(isLabs ? 'labs' : restored ? 'workspace' : 'start');
  // Remembered each time Labs is opened, so Back can return to the right place.
  const labsFrom = ref<AppView>(restored ? 'workspace' : 'start');

  function createProject(p: CreateProjectInput): void {
    const proj: SavedProject = {
      boardId: p.boardId,
      name: p.name ?? 'nhap_nhay_led',
      sketch: p.sketch ?? defaultSketch(p.boardId),
      canvas: p.canvas ?? null,
    };
    project.value = proj;
    save(proj);
    view.value = 'workspace';
  }

  /** Resume the in-memory project from the Start screen (the Resume button only shows when one exists). */
  function resume(): void {
    if (project.value) view.value = 'workspace';
  }

  function openLabs(): void {
    labsFrom.value = view.value === 'workspace' ? 'workspace' : 'start';
    view.value = 'labs';
  }

  /** Back out of Labs to its origin; fall back to Start if there is no project to return to. */
  function closeLabs(): void {
    view.value = labsFrom.value === 'workspace' && project.value ? 'workspace' : 'start';
  }

  function goStart(): void {
    view.value = 'start';
  }

  const hasProject = (): boolean => project.value !== null;

  return {
    view,
    project,
    labsFrom,
    createProject,
    resume,
    openLabs,
    closeLabs,
    goStart,
    hasProject,
  };
}
