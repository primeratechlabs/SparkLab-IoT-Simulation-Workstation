/**
 * `<sparklab-water-sensor>` — an analog water-level probe, built the SAME way @wokwi/elements are: a
 * `LitElement` with a reactive `level` property and a wokwi-compatible `pinInfo` (name + x/y + `signals`),
 * so the canvas treats it exactly like a real wokwi part. @wokwi/elements 1.9.2 ships no water sensor, so
 * this extends the same `lit` base the wokwi library uses and mirrors its element shape (property-driven
 * `render()`, no hard-coded geometry — the water fill is COMPUTED from `level`).
 *
 * Artwork + pin layout are the "Trình nối mạch" Claude Design project's water sensor (assets/water.svg): a
 * red comb-probe PCB, header pins S (signal) / + (VCC) / − (GND) on the right; water rises from the blade
 * tip (left) across the comb in proportion to `level` (0–100).
 */
import { LitElement, html, type TemplateResult } from 'lit';

// wokwi pin-signal descriptors (same shape as @wokwi/elements' internal `./pin` — analog/GND/VCC), so the
// canvas reads the pin roles identically to a real wokwi element.
const analog = (channel: number) => ({ type: 'analog', channel }) as const;
const GND = () => ({ type: 'power', signal: 'GND' }) as const;
const VCC = (voltage?: number) => ({ type: 'power', signal: 'VCC', voltage }) as const;

export interface ElementPin {
  name: string;
  x: number;
  y: number;
  signals: unknown[];
}

// The design's artwork is a 440×140 viewBox; we render it at ART_W→DISP_W (a sensor-sized part on the
// canvas, like the wokwi elements do — they set a small mm/px width over a larger viewBox). The canvas
// reads pinInfo x/y as PIXELS at the element's rendered size (offsetWidth), so pins are scaled to DISP.
const ART_W = 440;
const ART_H = 140;
const DISP_W = 216; // rendered width on the canvas — big enough that the 3 header pins are easy to grab
const DISP_H = (DISP_W * ART_H) / ART_W; // keep the aspect ratio
const SX = DISP_W / ART_W;
const SY = DISP_H / ART_H;

// The comb (sensing) area in ARTWORK coords the water overlay fills, left→right with `level`. Derived from
// the design's proportions (x 3%..57%, y 19%..85% of the board) — constants, not magic numbers in render().
const COMB = { x: 0.03 * ART_W, y: 0.19 * ART_H, maxW: (0.57 - 0.03) * ART_W, h: 0.66 * ART_H };

// Header pins S/+/− on the right, in ARTWORK coords (from assets/water.svg's gold pads) → scaled to DISP px.
const PIN_ART: ReadonlyArray<{ name: string; ax: number; ay: number; signals: unknown[] }> = [
  { name: 'SIG', ax: 426, ay: 42.6, signals: [analog(0)] },
  { name: 'VCC', ax: 426, ay: 67.5, signals: [VCC(5)] },
  { name: 'GND', ax: 426, ay: 92.5, signals: [GND()] },
];

export class WaterLevelSensorElement extends LitElement {
  static override properties = {
    level: { type: Number },
  };

  /** Water level the probe is submerged in, 0–100 % (reactive). `declare` + a constructor default keeps
   *  Lit's generated accessor (a class-field initialiser would shadow it and drop reactivity). */
  declare level: number;

  constructor() {
    super();
    this.level = 40;
  }

  /** wokwi-compatible pin geometry — pixel offsets at the rendered size (art coords × display scale). */
  readonly pinInfo: ElementPin[] = PIN_ART.map((p) => ({
    name: p.name,
    x: p.ax * SX,
    y: p.ay * SY,
    signals: p.signals,
  }));

  override render(): TemplateResult {
    // Water fill is COMPUTED from `level` — a single rect whose WIDTH grows as the probe submerges from the
    // blade tip (left). Only attribute VALUES are interpolated (no nested svg`` fragment), so it renders in
    // every DOM including the test's happy-dom. The board artwork below is the design's assets/water.svg.
    const lv = Math.max(0, Math.min(100, Number(this.level) || 0));
    const ww = COMB.maxW * (lv / 100);
    const edge = COMB.x + ww;
    return html`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" width="${DISP_W}" height="${DISP_H}">
        <defs>
          <linearGradient id="pcb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E63E2C"></stop><stop offset="1" stop-color="#C62E1E"></stop></linearGradient>
          <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EDF1F4"></stop><stop offset=".5" stop-color="#C4CCD3"></stop><stop offset="1" stop-color="#9FA9B2"></stop></linearGradient>
          <linearGradient id="metalV" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#EDF1F4"></stop><stop offset=".5" stop-color="#C4CCD3"></stop><stop offset="1" stop-color="#9FA9B2"></stop></linearGradient>
          <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F3D67A"></stop><stop offset=".5" stop-color="#E3B84A"></stop><stop offset="1" stop-color="#B98F2E"></stop></linearGradient>
          <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5AAFE6" stop-opacity=".34"></stop><stop offset="1" stop-color="#3C96D7" stop-opacity=".55"></stop></linearGradient>
        </defs>
        <path d="M8 22 H300 Q314 22 316 12 Q317 6 326 6 H388 Q434 6 434 42 V98 Q434 134 388 134 H326 Q317 134 316 128 Q314 118 300 118 H8 Q4 118 4 114 V26 Q4 22 8 22 Z" fill="url(#pcb)" stroke="#93231a" stroke-width="1.5"></path>
        <path d="M8 22 H300 Q314 22 316 12 Q317 6 326 6 H388 Q434 6 434 42 V38 H4 V26 Q4 22 8 22 Z" fill="#ffffff" opacity=".07"></path>
        <circle cx="434" cy="70" r="20" fill="#a5271b" opacity=".45"></circle>
        <rect x="14" y="26" width="7" height="92" rx="3.5" fill="url(#metalV)"></rect><rect x="14" y="26" width="2.4" height="92" rx="1.2" fill="#ffffff" opacity=".4"></rect>
        <rect x="18" y="28.5" width="234" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="39" width="228" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="49.5" width="234" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="60" width="228" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="70.5" width="234" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="81" width="228" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="91.5" width="234" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="102" width="228" height="3" rx="1.5" fill="url(#metal)"></rect>
        <rect x="18" y="112.5" width="234" height="3" rx="1.5" fill="url(#metal)"></rect>
        <path d="M252 44 H352" stroke="#CBD2D8" stroke-width="2.2" fill="none" opacity=".8"></path>
        <path d="M246 72 H340" stroke="#CBD2D8" stroke-width="2.2" fill="none" opacity=".8"></path>
        <path d="M252 98 H352" stroke="#CBD2D8" stroke-width="2.2" fill="none" opacity=".8"></path>
        <circle cx="404" cy="30" r="12" fill="#7c1d13"></circle><circle cx="404" cy="30" r="12" fill="none" stroke="url(#metalV)" stroke-width="3"></circle><circle cx="404" cy="30" r="6.5" fill="#5c130b"></circle>
        <circle cx="356" cy="112" r="11" fill="#7c1d13"></circle><circle cx="356" cy="112" r="11" fill="none" stroke="url(#metalV)" stroke-width="3"></circle><circle cx="356" cy="112" r="6" fill="#5c130b"></circle>
        <text x="278" y="72" fill="#fbe6e2" font-family="'Segoe Script','Brush Script MT',cursive" font-size="20" font-weight="700" font-style="italic" text-anchor="middle" transform="rotate(90 278 72)">Sparkuino</text>
        <text x="366" y="94" fill="#f6d9d4" font-family="sans-serif" font-size="8.5" font-weight="600" text-anchor="middle" transform="rotate(90 366 94)">Power</text>
        <rect x="352" y="30" width="48" height="16" rx="2.5" fill="none" stroke="#fbe6e2" stroke-width="1.3"></rect>
        <text x="360" y="42.5" fill="#fbe6e2" font-family="sans-serif" font-size="12" font-weight="800" text-anchor="middle">S</text>
        <text x="376" y="42.5" fill="#fbe6e2" font-family="sans-serif" font-size="12" font-weight="800" text-anchor="middle">+</text>
        <text x="392" y="43" fill="#fbe6e2" font-family="sans-serif" font-size="13" font-weight="800" text-anchor="middle">−</text>
        <rect x="396" y="34" width="18" height="72" rx="2.5" fill="#121316" stroke="#000" stroke-width="1"></rect>
        <rect x="399" y="37" width="12" height="66" rx="2" fill="#1b1d21"></rect>
        <g fill="url(#gold)" stroke="#8f6f24" stroke-width="0.8">
          <rect x="411" y="38.5" width="26" height="7" rx="1.5"></rect>
          <rect x="411" y="63.5" width="26" height="7" rx="1.5"></rect>
          <rect x="411" y="88.5" width="26" height="7" rx="1.5"></rect>
        </g>
        <rect class="water-fill" x="${COMB.x}" y="${COMB.y}" width="${ww}" height="${COMB.h}" fill="url(#water)" rx="2"></rect>
        <line x1="${edge}" y1="${COMB.y - 2}" x2="${edge}" y2="${COMB.y + COMB.h + 2}" stroke="#8FD0F5" stroke-width="${lv > 0 ? 2 : 0}" opacity="0.9"></line>
      </svg>
    `;
  }
}

/** Register the element (idempotent — guarded so a re-import never throws). */
export function registerWaterSensorElement(): void {
  if (typeof customElements !== 'undefined' && !customElements.get('sparklab-water-sensor')) {
    customElements.define('sparklab-water-sensor', WaterLevelSensorElement);
  }
}

registerWaterSensorElement();
