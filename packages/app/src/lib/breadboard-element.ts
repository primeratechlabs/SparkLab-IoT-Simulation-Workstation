/**
 * `<sparklab-breadboard>` — a vendored visual breadboard element (a half / 400-point board). @wokwi/elements
 * 1.9.2 ships NO breadboard, so this is our own: a plain custom element (no Lit) that renders the board SVG
 * and exposes a wokwi-compatible `pinInfo` ([{name,x,y,signals}], pixel offsets from the top-left) so the
 * canvas places pin dots + wires onto each hole exactly as it does for a real wokwi element. The ELECTRICAL
 * connectivity (which holes share a net) is NOT here — it lives in @sparklab/schematic `breadboardGroupOf`,
 * applied by the canvas→document bridge. This element owns only the picture + the hole geometry.
 *
 * Hole names follow the schematic contract (breadboard.ts): main grid `<row><col>` (a–j × 1..30), rails
 * `tp|tn|bp|bn<n>`. Positions are computed here from those names.
 */
import { breadboardHoles, BREADBOARD_COLS, BREADBOARD_RAIL_HOLES } from '@sparklab/schematic';

interface ElementPin {
  name: string;
  x: number;
  y: number;
  signals: unknown[];
}

// Hole pitch = @wokwi/elements' component grid (~0.1"), so a part's pins drop straight into the holes when
// plugged in: a pushbutton spans exactly 7×2 holes, a potentiometer 3, an LED ~1, a resistor ~6. Everything
// below DERIVES from P, so the board is one consistent standard shared with the components (no rescaling).
const P = 9.5; // hole pitch (px) — the shared device/breadboard standard
const LEFT = 13; // left margin to the first column
const Y_TP = P; // top "+" rail
const Y_TN = Y_TP + P; // top "−" rail
const Y_A = Y_TN + 2 * P; // first grid row (a)
const Y_F = Y_A + 6 * P; // first bottom-half row (f) — a 2·P centre channel sits between rows e and f
const Y_BP = Y_F + 6 * P; // bottom "+" rail
const Y_BN = Y_BP + P; // bottom "−" rail
const WIDTH = LEFT * 2 + (BREADBOARD_COLS - 1) * P;
const HEIGHT = Y_BN + P;

/** Rail hole `n` (1..25) sits at this column index, leaving a gap after every group of 5 (like a real rail). */
function railCol(n: number): number {
  return n + Math.floor((n - 1) / 5);
}

/** Pixel position of a hole, from its name (the schematic naming contract). */
function holePos(name: string): { x: number; y: number } {
  const grid = /^([a-j])(\d+)$/.exec(name);
  if (grid) {
    const row = grid[1]!.charCodeAt(0) - 'a'.charCodeAt(0); // 0..9
    const col = Number(grid[2]);
    const x = LEFT + (col - 1) * P;
    const y = row <= 4 ? Y_A + row * P : Y_F + (row - 5) * P;
    return { x, y };
  }
  const rail = /^(tp|tn|bp|bn)(\d+)$/.exec(name)!;
  const n = Number(rail[2]);
  const x = LEFT + (railCol(n) - 1) * P;
  const y = { tp: Y_TP, tn: Y_TN, bp: Y_BP, bn: Y_BN }[rail[1]!]!;
  return { x, y };
}

const PINS: ElementPin[] = breadboardHoles().map((name) => ({
  name,
  ...holePos(name),
  signals: [],
}));

function svgMarkup(): string {
  const holes = PINS.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.1" fill="#3a3a3a"/>`).join(
    '',
  );
  // Rail guide lines (red + / blue −), top + bottom; the centre channel groove between e and f.
  const railLine = (y: number, color: string) =>
    `<line x1="${LEFT - 6}" y1="${y}" x2="${WIDTH - LEFT + 6}" y2="${y}" stroke="${color}" stroke-width="1" opacity="0.55"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="6" fill="#f3efe6" stroke="#cdc6b4"/>
    ${railLine(Y_TP - 5, '#d23b3b')}${railLine(Y_TN + 5, '#3b6fd2')}
    ${railLine(Y_BP - 5, '#d23b3b')}${railLine(Y_BN + 5, '#3b6fd2')}
    <rect x="0" y="${(Y_A + 4 * P + Y_F) / 2 - 5}" width="${WIDTH}" height="10" fill="#e3ddcf"/>
    ${holes}
  </svg>`;
}

/** A vendored breadboard custom element. Light-DOM SVG + a wokwi-style `pinInfo` getter. */
export class SparklabBreadboardElement extends HTMLElement {
  connectedCallback(): void {
    if (!this.innerHTML) this.innerHTML = svgMarkup();
  }
  /** wokwi-compatible pin geometry (pixel offsets from the element's top-left at natural size). */
  get pinInfo(): ElementPin[] {
    return PINS;
  }
}

/** Register the element (idempotent — guarded so a future @wokwi breadboard or a re-import never throws). */
export function registerBreadboardElement(): void {
  if (typeof customElements !== 'undefined' && !customElements.get('sparklab-breadboard')) {
    customElements.define('sparklab-breadboard', SparklabBreadboardElement);
  }
}

// Side-effect registration (mirrors `import '@wokwi/elements'`), plus the named export for tests.
registerBreadboardElement();

export { breadboardHoles, BREADBOARD_COLS, BREADBOARD_RAIL_HOLES };
