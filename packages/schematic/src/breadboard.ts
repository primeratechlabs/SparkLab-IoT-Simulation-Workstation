/**
 * Breadboard electrical topology — the CONTRACT shared by the visual `<sparklab-breadboard>` element
 * (which names + positions the holes) and the canvas→document bridge (which turns a hole a wire lands on
 * into the electrical NET it belongs to). A breadboard adds no active component; its only behaviour is
 * connectivity: holes in the same group are one node, so two component pins plugged into the same group
 * are wired together WITHOUT an explicit wire — exactly how a real breadboard works.
 *
 * Half (400-point) layout: 30 numbered columns, each split into a TOP half {a,b,c,d,e} and a BOTTOM
 * half {f,g,h,i,j} (the centre channel isolates the two), plus 4 continuous power rails (top +/−,
 * bottom +/−). Hole-name convention (the element MUST follow it so `breadboardGroupOf` resolves):
 *   - main grid:  `<row><col>`  row ∈ a..j, col ∈ 1..30   (e.g. `a1`, `e15`, `j30`)
 *   - power rails: `tp<n>` / `tn<n>` / `bp<n>` / `bn<n>`   n ∈ 1..RAIL_HOLES  (top +/−, bottom +/−)
 */
export const BREADBOARD_COLS = 30;
export const BREADBOARD_RAIL_HOLES = 25;
const ROWS_TOP = ['a', 'b', 'c', 'd', 'e'] as const;
const ROWS_BOTTOM = ['f', 'g', 'h', 'i', 'j'] as const;

/** Every hole name on the board, in a stable order (element reads this so names never drift). */
export function breadboardHoles(): string[] {
  const holes: string[] = [];
  for (let col = 1; col <= BREADBOARD_COLS; col++) {
    for (const r of ROWS_TOP) holes.push(`${r}${col}`);
    for (const r of ROWS_BOTTOM) holes.push(`${r}${col}`);
  }
  for (const prefix of ['tp', 'tn', 'bp', 'bn']) {
    for (let n = 1; n <= BREADBOARD_RAIL_HOLES; n++) holes.push(`${prefix}${n}`);
  }
  return holes;
}

/**
 * The electrical net a hole belongs to. Top-half holes {a–e} of column N share `Tcol<N>`; bottom-half
 * {f–j} share `Bcol<N>`; each power rail is one continuous net. Returns the hole itself for an
 * unrecognised name (defensive — an isolated node, never silently merged with another).
 */
export function breadboardGroupOf(hole: string): string {
  const grid = /^([a-j])(\d+)$/.exec(hole);
  if (grid) {
    const row = grid[1]!;
    const col = Number(grid[2]);
    // Defence-in-depth: an out-of-range column (the element only ever emits 1..N) stays ISOLATED rather
    // than becoming a phantom group not in breadboardGroups() — so a hole can never map to a non-existent
    // catalog pin without being surfaced as unmapped.
    if (col < 1 || col > BREADBOARD_COLS) return hole;
    return row <= 'e' ? `Tcol${col}` : `Bcol${col}`;
  }
  const rail = /^(tp|tn|bp|bn)\d+$/.exec(hole);
  if (rail) {
    return { tp: 'Trail+', tn: 'Trail-', bp: 'Brail+', bn: 'Brail-' }[rail[1]!]!;
  }
  return hole;
}

/** All distinct net-group names (the breadboard's catalog "pins" — the nodes the netlist can reference). */
export function breadboardGroups(): string[] {
  const groups: string[] = [];
  for (let col = 1; col <= BREADBOARD_COLS; col++) groups.push(`Tcol${col}`, `Bcol${col}`);
  groups.push('Trail+', 'Trail-', 'Brail+', 'Brail-');
  return groups;
}
