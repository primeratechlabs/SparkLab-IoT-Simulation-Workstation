/**
 * useResizableLayout — flexible sizing for the workspace grid (editor | circuit / serial). Owns the
 * editor-column fraction (of total width) + the serial-panel height, driven by draggable gutters and
 * persisted so a layout survives reload. Pure-ish: the drag math is unit-testable via `dragTo`.
 *
 * Defaults: editor ~1/3 of the width (the circuit gets the rest), serial 232px. Clamped so no panel
 * collapses. Double-clicking a gutter resets via `reset()`.
 */
import { ref, watch, type Ref } from 'vue';

const COL_MIN = 0.18; // editor never narrower than 18% …
const COL_MAX = 0.6; //  … nor wider than 60% of the width
const ROW_MIN = 120; // serial never shorter than 120px
const TOP_MIN = 200; // keep at least this much height for the circuit above the serial
export const DEFAULT_EDITOR_FRAC = 1 / 3;
export const DEFAULT_SERIAL_PX = 232;

export interface LayoutState {
  editorFrac: number;
  serialPx: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function load(key: string): Partial<LayoutState> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<LayoutState>;
  } catch {
    return {};
  }
}

/**
 * Compute the new layout fraction/height for a pointer position, given the layout container's rect.
 * `kind:'col'` → editor fraction from the cursor X; `kind:'row'` → serial height from the cursor Y.
 * Pure function (no DOM/refs) so the clamping logic is directly tested.
 */
export function dragTo(
  kind: 'col' | 'row',
  clientPos: number,
  rect: { left: number; top: number; width: number; height: number },
): number {
  if (kind === 'col') {
    return clamp((clientPos - rect.left) / rect.width, COL_MIN, COL_MAX);
  }
  const fromBottom = rect.top + rect.height - clientPos;
  const rowMax = Math.max(ROW_MIN, rect.height - TOP_MIN);
  return clamp(fromBottom, ROW_MIN, rowMax);
}

export function useResizableLayout(
  container: Ref<HTMLElement | null>,
  storageKey = 'sparklab:ws-layout',
) {
  const saved = load(storageKey);
  const editorFrac = ref(clamp(saved.editorFrac ?? DEFAULT_EDITOR_FRAC, COL_MIN, COL_MAX));
  const serialPx = ref(Math.max(ROW_MIN, saved.serialPx ?? DEFAULT_SERIAL_PX));

  watch([editorFrac, serialPx], () => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ editorFrac: editorFrac.value, serialPx: serialPx.value }),
      );
    } catch {
      /* storage disabled — sizing just won't persist */
    }
  });

  let mode: 'col' | 'row' | null = null;
  function onMove(e: PointerEvent): void {
    const el = container.value;
    if (!el || !mode) return;
    const r = el.getBoundingClientRect();
    const pos = mode === 'col' ? e.clientX : e.clientY;
    const next = dragTo(mode, pos, r);
    if (mode === 'col') editorFrac.value = next;
    else serialPx.value = next;
  }
  function onUp(): void {
    mode = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }
  function start(kind: 'col' | 'row', e: PointerEvent): void {
    mode = kind;
    e.preventDefault();
    // Lock the cursor + suppress text selection for the whole drag (the gutter is thin).
    document.body.style.cursor = kind === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function reset(): void {
    editorFrac.value = DEFAULT_EDITOR_FRAC;
    serialPx.value = DEFAULT_SERIAL_PX;
  }

  return {
    editorFrac,
    serialPx,
    startCol: (e: PointerEvent) => start('col', e),
    startRow: (e: PointerEvent) => start('row', e),
    reset,
  };
}
