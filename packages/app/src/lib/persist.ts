/**
 * Local project autosave — makes the "Đã lưu tự động" promise true (AUD-001). The board, name, sketch AND
 * the drawn circuit (raw canvas snapshot: placed parts + wires + board pose) are persisted to localStorage
 * on every edit and restored on reload, so a refresh never loses the user's code OR circuit. Versioned with
 * migration for older (sketch-only) entries. Storage failures (quota / private mode) are reported back to
 * the caller (not swallowed) so the UI can show an honest "not saved" state instead of lying.
 */

/** Raw canvas snapshot — the editor's own placed/wire/board-pose data (JSON-serializable). Kept loosely
 *  typed here; the canvas validates it on restore. */
export interface SavedCanvas {
  placed: unknown[];
  wires: unknown[];
  boardPos: { x: number; y: number };
  boardRot: number;
}

export interface SavedProject {
  /** Schema version for migration (absent/older = v1, sketch-only). */
  version?: number;
  boardId: string;
  name: string;
  sketch: string;
  /** The drawn circuit (null = empty). */
  canvas?: SavedCanvas | null;
}

const KEY = 'sparklab:project';
export const PROJECT_VERSION = 2;

/** Persist the project. Returns true on success; false if storage rejected it (quota/unavailable) so the
 *  caller can surface an honest "chưa lưu" state rather than claim success. */
export function saveProject(p: SavedProject): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, version: PROJECT_VERSION }));
    return true;
  } catch {
    return false; // quota exceeded / storage unavailable — the caller decides how to surface it
  }
}

function isCanvas(c: unknown): c is SavedCanvas {
  return (
    c !== null &&
    typeof c === 'object' &&
    Array.isArray((c as SavedCanvas).placed) &&
    Array.isArray((c as SavedCanvas).wires) &&
    typeof (c as SavedCanvas).boardRot === 'number'
  );
}

export function loadProject(): SavedProject | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p: unknown = JSON.parse(raw);
    if (
      p !== null &&
      typeof p === 'object' &&
      typeof (p as SavedProject).boardId === 'string' &&
      typeof (p as SavedProject).name === 'string' &&
      typeof (p as SavedProject).sketch === 'string'
    ) {
      const sp = p as SavedProject;
      // Migration: a v1 (sketch-only) entry has no `version`/`canvas` — load it with an empty circuit.
      return {
        version: sp.version ?? 1,
        boardId: sp.boardId,
        name: sp.name,
        sketch: sp.sketch,
        canvas: isCanvas(sp.canvas) ? sp.canvas : null,
      };
    }
  } catch {
    /* corrupt entry — ignore */
  }
  return null;
}

export function clearProject(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
