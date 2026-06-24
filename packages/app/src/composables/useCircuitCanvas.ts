/**
 * useCircuitCanvas — the headless model for the wokwi drag-drop canvas, porting the "Trình nối mạch"
 * design's interaction model: place parts, rotate/flip them, and wire pins with a rubber-band that
 * follows the cursor and supports bend points. Kept out of the SFC so the canvas stays presentational
 * and this logic is the seam to later bind to @sparklab/schematic's EditorSession.
 *
 * Wiring flow (from the design): click a pin → a dashed rubber-band trails the cursor → click empty
 * canvas to drop a bend point → click the target pin to commit the wire (Esc / same-pin cancels).
 * Wires colour themselves by signal (GND black, power red, else a cycling palette).
 *
 * Pin geometry: a wokwi element's `pinInfo` x/y are PIXEL offsets from the element's top-left at its
 * natural rendered size (we render 1:1), so they map directly onto the part origin. A part may be
 * rotated/flipped, so we mirror/rotate each pin around the element centre — the design's `pinAbs`.
 */
import { ref, reactive, computed, type Ref } from 'vue';
import { wireColor } from '../lib/pin-signal.js';
import {
  defaultPropsFor,
  boardPin,
  BOARD_CATALOG,
  wokwiBoardTagFor,
  LED_COLORS,
  type BoardPin,
  type PropValue,
} from '@sparklab/schematic';

export interface ElementPin {
  name: string;
  x: number;
  y: number;
  signals: unknown[];
}
interface WokwiElement extends HTMLElement {
  pinInfo?: ElementPin[];
  updateComplete?: Promise<unknown>;
}
export interface Placed {
  cid: string;
  type: string;
  tag: string;
  x: number;
  y: number;
  rot: number; // degrees, 30° steps
  flip: boolean; // horizontal mirror
  /** Editable attributes (catalog `properties` + the `_adc` sensor-stimulus value), the single source. */
  props: Record<string, PropValue>;
}
export interface Point {
  x: number;
  y: number;
}
export interface CanvasWire {
  id: string;
  from: { cid: string; pin: string };
  to: { cid: string; pin: string };
  points: Point[]; // bend points between from and to
  color?: string; // user-chosen stroke colour (overrides the auto signal colour); UI only, no electrical effect
}
interface PinPx {
  name: string;
  px: number;
  py: number;
  signals: unknown[]; // wokwi pinInfo signals — carry GND/VCC/I2C/analog roles for topology checks
}
interface Dims {
  w: number;
  h: number;
}

export const BOARD_CID = '__board__';
const DROP_X = 320;
const DROP_Y = 60;
const DROP_STEP = 70; // vertical gap between freshly-dropped parts
const DROP_ROWS = 4; // parts per column before starting a new column (so they never overlap — UX risk)
const DROP_COL_STEP = 132; // horizontal gap to the next drop column
const PART_MARGIN = 24; // keep this many px of a dragged part on-canvas
const ROT_STEP = 30; // degrees per rotate click (design uses 30° steps)
const BOARD_ROT_STEP = 30; // boards rotate in 30° steps too (matches parts; pinAbs tracks any angle)
const GRID = 8; // wire bend points snap to this px grid (alignment aid)
/** The palette offered for recolouring a wire (common breadboard jumper colours). */
export const WIRE_COLORS = [
  '#e2554b',
  '#111827',
  '#2f9e44',
  '#1c7ed6',
  '#f59f00',
  '#ffffff',
  '#7048e8',
  '#e8590c',
] as const;
const snap = (v: number): number => Math.round(v / GRID) * GRID;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Zoom that fits `content` into `view` with a small margin, clamped to [min,max] (AUD-028). Pure. Returns
 *  `min` for a non-positive viewport (not yet laid out) so the canvas never collapses to 0. */
export function computeFitZoom(
  viewW: number,
  viewH: number,
  contentW: number,
  contentH: number,
  min: number,
  max: number,
): number {
  if (viewW <= 0 || viewH <= 0 || contentW <= 0 || contentH <= 0) return min;
  const margin = 0.94; // leave ~6% breathing room so the board isn't flush against the scroll edges
  return clamp(Math.min(viewW / contentW, viewH / contentH) * margin, min, max);
}

// ── net trace + electrical-topology truth (wires → what each component is actually connected to) ──
// A general union-find over the drawn wires. Board pin NUMBERS come canonically from BOARD_CATALOG
// (so Uno "13", ESP32 "D13"/"TX0"/"VP" and C3 "GPIOn" all resolve), and the rail/bus role (GND, VCC,
// SDA, SCL, analog) comes from each pin's wokwi `signals`. componentStatus() then enforces a valid
// power/return/polarity/bus topology before a part reflects or drives the firmware.
export interface ResolvedPin {
  digital?: number;
  analog?: number;
}
/** What a net reaches: a signal pin/channel (≤1 resistor hop) plus rail/bus membership. */
export interface PinRole {
  digital?: number;
  analog?: number;
  viaResistor?: boolean;
  gnd: boolean;
  vcc: boolean;
  sda: boolean;
  scl: boolean;
}
export interface ComponentStatus {
  ok: boolean; // topology is valid → the part may reflect/drive the firmware
  digital?: number;
  analog?: number;
  issues: string[]; // human-readable wiring problems (missing GND, reversed polarity, …)
}
const NET_SEP = String.fromCharCode(0); // NUL separator — never appears in a cid or pin name
function pinKey(cid: string, pin: string): string {
  return cid + NET_SEP + pin;
}
function unPinKey(k: string): { cid: string; pin: string } {
  const i = k.indexOf(NET_SEP);
  return { cid: k.slice(0, i), pin: k.slice(i + 1) };
}
/** A board header pin's electrical role — pin number/ADC channel (canonical) + rail/bus (from signals). */
function boardPinRole(boardId: string, name: string, signals: unknown[]): PinRole {
  const bp = boardPin(boardId, name) ?? boardPin(boardId, `D${name}`); // Uno "13" ↔ catalog "D13"
  const sig = (signals ?? []) as Array<{ type?: string; signal?: string }>;
  const has = (t: string, s?: string): boolean =>
    sig.some((x) => x.type === t && (s === undefined || x.signal === s));
  return {
    digital: bp?.digitalPin,
    analog: bp?.adcChannel,
    gnd: has('power', 'GND') || /^GND/.test(name) || bp?.type === 'ground',
    vcc: has('power', 'VCC') || /^(5V|3V3|3\.3V|VIN)$/.test(name) || bp?.type === 'power',
    sda: has('i2c', 'SDA') || bp?.i2c === 'SDA',
    scl: has('i2c', 'SCL') || bp?.i2c === 'SCL',
  };
}
/** Synthesise wokwi-style `signals` for a catalog board pin (used to render boards with no wokwi element). */
function boardPinSignals(p: BoardPin): unknown[] {
  const s: unknown[] = [];
  if (p.type === 'ground') s.push({ type: 'power', signal: 'GND' });
  if (p.type === 'power') s.push({ type: 'power', signal: 'VCC' });
  if (p.adcChannel !== undefined) s.push({ type: 'analog', channel: p.adcChannel });
  if (p.i2c) s.push({ type: 'i2c', signal: p.i2c });
  return s;
}
// Custom-board (no wokwi element) pin layout — two columns, used for BOTH the rendered art and the pin
// geometry so the visual pins and the logical pins are the same canonical mapping (QA P0-2).
const CB_PAD = 18;
const CB_COL_GAP = 150;
const CB_ROW_GAP = 22;
const CB_TOP = 26;
const CB_BODY_W = 70; // extra width of the board body between the two pin columns (label area)

export function useCircuitCanvas(canvasEl: Ref<HTMLElement | null>, boardIdRef?: Ref<string>) {
  const boardId = (): string => boardIdRef?.value ?? 'arduino-uno';
  const placed = ref<Placed[]>([]);
  const wires = ref<CanvasWire[]>([]);
  const pinsPx = reactive<Record<string, PinPx[]>>({}); // cid → pixel-space pins (origin-relative)
  const dims = reactive<Record<string, Dims>>({}); // cid → element box (rotation centre)
  const pendingPin = ref<{ cid: string; pin: string } | null>(null);
  const pendingPoints = ref<Point[]>([]); // bend points dropped while a wire is in flight
  const hover = ref<{ cid: string; pin: string } | null>(null);
  const selected = ref<string | null>(null);
  const selectedWire = ref<string | null>(null); // the wire whose colour toolbar is open
  const mouse = reactive<Point>({ x: 0, y: 0 }); // canvas-relative cursor (drives the rubber-band)
  // A tall custom board (ESP32-C3) starts near the top-left so its lower pins clear the "+ Linh kiện"
  // FAB; a wokwi board starts lower. Either way the board is now draggable from here.
  const boardPos = reactive(isCustomBoard() ? { x: 30, y: 12 } : { x: 40, y: 150 });
  const boardRot = ref(0); // board rotation in degrees (90° steps)
  const zoom = ref(1); // canvas magnification (the content layer is CSS-scaled; pointer coords ÷ zoom)

  let partSeq = 0;
  let wireSeq = 0;

  function addPart(type: string, tag: string): string {
    partSeq += 1;
    const cid = `${type}-${partSeq}`;
    // Stagger drops in a grid (DROP_ROWS per column, then a new column) so a 5th+ part never lands on
    // top of an earlier one — the user can place several parts before wiring (multi-device UX risk).
    const idx = placed.value.length;
    const part: Placed = {
      cid,
      type,
      tag,
      x: DROP_X + Math.floor(idx / DROP_ROWS) * DROP_COL_STEP,
      y: DROP_Y + (idx % DROP_ROWS) * DROP_STEP,
      rot: 0,
      flip: false,
      props: defaultPropsFor(type), // catalog defaults (colour, ohms, beta, …)
    };
    placed.value.push(part);
    selected.value = cid;
    return cid;
  }
  function removePart(cid: string): void {
    placed.value = placed.value.filter((p) => p.cid !== cid);
    wires.value = wires.value.filter((w) => w.from.cid !== cid && w.to.cid !== cid);
    if (pendingPin.value?.cid === cid) cancelPending();
    if (selected.value === cid) selected.value = null;
    delete pinsPx[cid];
    delete dims[cid];
  }

  // ── pin geometry ────────────────────────────────────────────────────────────
  /** A board with no wokwi element (e.g. ESP32-C3) → we draw it ourselves from the board catalog. */
  function isCustomBoard(): boolean {
    return wokwiBoardTagFor(boardId()) === undefined && BOARD_CATALOG[boardId()] !== undefined;
  }
  /** The catalog board's pins laid out in two columns (same coords for the art and the geometry). */
  function catalogBoardPins(): PinPx[] {
    const entry = BOARD_CATALOG[boardId()];
    if (!entry) return [];
    const half = Math.ceil(entry.pins.length / 2);
    return entry.pins.map((p, i) => {
      const col = i < half ? 0 : 1;
      const row = i < half ? i : i - half;
      return {
        name: p.name,
        px: CB_PAD + col * CB_COL_GAP,
        py: CB_TOP + row * CB_ROW_GAP,
        signals: boardPinSignals(p),
      };
    });
  }
  function elementFor(cid: string): WokwiElement | null {
    return (
      (canvasEl.value?.querySelector(`[data-cid="${cid}"] .wokwi-host`) as WokwiElement | null) ??
      null
    );
  }
  function measurePins(cid: string): void {
    const el = elementFor(cid);
    if (!el?.pinInfo) {
      if (cid === BOARD_CID && isCustomBoard()) {
        const entry = BOARD_CATALOG[boardId()]!;
        pinsPx[cid] = catalogBoardPins();
        const half = Math.ceil(entry.pins.length / 2);
        dims[cid] = { w: CB_COL_GAP + CB_PAD * 2 + CB_BODY_W, h: CB_TOP * 2 + half * CB_ROW_GAP };
      }
      return;
    }
    // wokwi pinInfo x/y are PIXEL offsets from the element's top-left at its natural rendered size,
    // and we render each element 1:1 (no CSS scale), so they map directly. They are NOT viewBox units
    // — a board's pinInfo x reaches ~255 while its viewBox is only ~72 wide, so scaling by the viewBox
    // throws the dots far off the board.
    pinsPx[cid] = el.pinInfo.map((p) => ({
      name: p.name,
      px: p.x,
      py: p.y,
      signals: p.signals ?? [],
    }));
    dims[cid] = { w: el.offsetWidth || 0, h: el.offsetHeight || 0 };
  }
  async function refreshPin(cid: string): Promise<void> {
    const el = elementFor(cid);
    if (!el) {
      if (cid === BOARD_CID && isCustomBoard()) measurePins(cid); // custom board: pins from the catalog
      return;
    }
    if (el.updateComplete) {
      try {
        await el.updateComplete;
      } catch {
        /* element teardown — ignore */
      }
    }
    measurePins(cid);
    el.addEventListener('pininfo-change', () => measurePins(cid));
  }
  async function refreshAll(): Promise<void> {
    await Promise.all([refreshPin(BOARD_CID), ...placed.value.map((p) => refreshPin(p.cid))]);
  }
  /** Art for a board with no wokwi element (drawn from the catalog), or null when a wokwi board is used. */
  const boardLayout = computed(() => {
    if (!isCustomBoard()) return null;
    const entry = BOARD_CATALOG[boardId()]!;
    const half = Math.ceil(entry.pins.length / 2);
    const pins = catalogBoardPins().map((p, i) => ({
      name: p.name,
      px: p.px,
      py: p.py,
      right: i >= half,
    }));
    return {
      name: entry.displayName,
      mcu: entry.mcu,
      pins,
      w: CB_COL_GAP + CB_PAD * 2 + CB_BODY_W,
      h: CB_TOP * 2 + half * CB_ROW_GAP,
    };
  });

  // A tall custom board (ESP32-C3) is drawn from near the top-left so its lower pins clear the
  // "+ Linh kiện" FAB (z-index 8) — otherwise the FAB would intercept clicks on those pins.
  const boardOrigin = computed<Point>(() => ({ x: boardPos.x, y: boardPos.y }));
  function originOf(cid: string): Point {
    if (cid === BOARD_CID) return boardOrigin.value;
    const p = placed.value.find((q) => q.cid === cid);
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  }
  /**
   * Pin centre in canvas pixels — mirror (flip) then rotate the pin around the element centre, the
   * same transform the rendered part receives, so dots track the art under any rotation. With rot=0
   * and flip=false this collapses to origin + pinInfo offset.
   */
  function pinAbs(cid: string, pin: string): Point | null {
    const info = pinsPx[cid]?.find((q) => q.name === pin);
    if (!info) return null;
    const o = originOf(cid);
    const part = cid === BOARD_CID ? null : placed.value.find((q) => q.cid === cid);
    const rot = cid === BOARD_CID ? boardRot.value : (part?.rot ?? 0);
    const flip = part?.flip ?? false;
    const d = dims[cid] ?? { w: 0, h: 0 };
    let lx = info.px;
    const ly = info.py;
    if (flip) lx = d.w - lx;
    const cx = d.w / 2;
    const cy = d.h / 2;
    const rad = (rot * Math.PI) / 180;
    const rx = lx - cx;
    const ry = ly - cy;
    const ca = Math.cos(rad);
    const sa = Math.sin(rad);
    return { x: o.x + cx + (rx * ca - ry * sa), y: o.y + cy + (rx * sa + ry * ca) };
  }

  // ── net trace ─────────────────────────────────────────────────────────────────
  // Rebuilds union-find over the drawn wires whenever they change. The returned resolver maps a
  // component pin to the board pin number / ADC channel it is wired to (≤1 series-resistor hop, the
  // MCU→resistor→LED idiom). An unwired pin resolves to null, so the UI leaves it inert.
  const resolver = computed(() => {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      let root = k;
      while (parent.get(root)! !== root) root = parent.get(root)!;
      let cur = k;
      while (parent.get(cur)! !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const w of wires.value) union(pinKey(w.from.cid, w.from.pin), pinKey(w.to.cid, w.to.pin));
    const membersByRoot = new Map<string, string[]>();
    for (const k of parent.keys()) {
      const root = find(k);
      const arr = membersByRoot.get(root);
      if (arr) arr.push(k);
      else membersByRoot.set(root, [k]);
    }
    const membersOf = (cid: string, pin: string): string[] | null => {
      const k = pinKey(cid, pin);
      if (!parent.has(k)) return null; // unwired
      return membersByRoot.get(find(k)) ?? [k];
    };
    const signalsOf = (cid: string, pin: string): unknown[] =>
      pinsPx[cid]?.find((p) => p.name === pin)?.signals ?? [];
    // Aggregate the electrical roles of every board pin sitting on a net (rails OR'd, signal first-wins).
    const boardRolesIn = (keys: string[]): PinRole => {
      const r: PinRole = { gnd: false, vcc: false, sda: false, scl: false };
      for (const k of keys) {
        const { cid, pin } = unPinKey(k);
        if (cid !== BOARD_CID) continue;
        const br = boardPinRole(boardId(), pin, signalsOf(BOARD_CID, pin));
        if (r.digital === undefined) r.digital = br.digital;
        if (r.analog === undefined) r.analog = br.analog;
        r.gnd ||= br.gnd;
        r.vcc ||= br.vcc;
        r.sda ||= br.sda;
        r.scl ||= br.scl;
      }
      return r;
    };
    return (cid: string, pin: string): PinRole => {
      const mem = membersOf(cid, pin);
      if (!mem) return { gnd: false, vcc: false, sda: false, scl: false };
      const r = boardRolesIn(mem);
      if (r.digital === undefined && r.analog === undefined) {
        // one series-resistor hop: MCU → resistor → this component (the LED idiom)
        for (const k of mem) {
          const { cid: c, pin: p } = unPinKey(k);
          if (placed.value.find((q) => q.cid === c)?.type !== 'resistor') continue;
          for (const other of pinsPx[c] ?? []) {
            if (other.name === p) continue;
            const om = membersOf(c, other.name);
            if (!om) continue;
            const r2 = boardRolesIn(om);
            if (r2.digital !== undefined || r2.analog !== undefined) {
              return { ...r, digital: r2.digital, analog: r2.analog, viaResistor: true };
            }
          }
        }
      }
      return r;
    };
  });
  function rolesOf(cid: string, pin: string): PinRole {
    return resolver.value(cid, pin);
  }
  /** Raw signal a component pin is wired to (≤1 resistor hop), or null — used for per-channel parts. */
  function resolvePin(cid: string, pin: string): ResolvedPin | null {
    const r = rolesOf(cid, pin);
    return r.digital !== undefined || r.analog !== undefined
      ? { digital: r.digital, analog: r.analog }
      : null;
  }
  /**
   * Electrical-topology truth for a placed part: is its power/return/polarity/bus valid, and which
   * firmware pin/channel does it act on? A part only reflects/drives the firmware when `ok`. Rules
   * follow the real circuit (LED needs anode→pin + cathode→GND; sensors need VCC+GND; I²C needs the
   * full bus) so an incomplete or reversed circuit stays inert and reports an issue.
   */
  function componentStatus(cid: string): ComponentStatus {
    const part = placed.value.find((p) => p.cid === cid);
    const pins = pinsPx[cid] ?? [];
    if (!part || !pins.length) return { ok: false, issues: [] };
    const role = (name: string): PinRole => rolesOf(cid, name);
    const all = pins.map((p) => role(p.name));
    const agg = {
      digital: all.find((r) => r.digital !== undefined)?.digital,
      analog: all.find((r) => r.analog !== undefined)?.analog,
      gnd: all.some((r) => r.gnd),
      vcc: all.some((r) => r.vcc),
      sda: all.some((r) => r.sda),
      scl: all.some((r) => r.scl),
    };
    const issues: string[] = [];
    switch (part.type) {
      case 'led': {
        const a = role('A');
        const c = role('C');
        if (a.digital !== undefined && c.gnd) {
          if (!a.viaResistor) issues.push('Nên có điện trở nối tiếp với LED');
          return { ok: true, digital: a.digital, issues };
        }
        if (c.digital !== undefined && a.gnd) issues.push('LED đảo cực (anode/cathode ngược)');
        else if (a.digital !== undefined) issues.push('Cathode chưa nối GND');
        else issues.push('Chưa nối đủ (anode → chân số, cathode → GND)');
        return { ok: false, issues };
      }
      case 'rgb-led': {
        const com = role('COM');
        const anyChannel = ['R', 'G', 'B'].some((n) => role(n).digital !== undefined);
        if (anyChannel && (com.gnd || com.vcc)) return { ok: true, issues };
        if (!anyChannel) issues.push('Chưa nối kênh R/G/B tới chân điều khiển');
        if (!com.gnd && !com.vcc) issues.push('Chân chung (COM) chưa nối GND/VCC');
        return { ok: false, issues };
      }
      case 'buzzer':
      case 'relay': {
        if (agg.digital !== undefined && agg.gnd) return { ok: true, digital: agg.digital, issues };
        if (agg.digital === undefined) issues.push('Chưa nối chân điều khiển tới GPIO');
        if (!agg.gnd) issues.push('Thiếu GND (đường hồi)');
        return { ok: false, issues };
      }
      case 'button': {
        if (agg.digital !== undefined && agg.gnd) return { ok: true, digital: agg.digital, issues };
        if (agg.digital === undefined) issues.push('Chưa nối tới GPIO');
        if (!agg.gnd) issues.push('Thiếu GND (nút kéo chân xuống GND)');
        return { ok: false, issues };
      }
      case 'potentiometer':
      case 'ldr':
      case 'ntc':
      case 'gas':
      case 'flame': {
        if (agg.analog !== undefined && agg.vcc && agg.gnd)
          return { ok: true, analog: agg.analog, issues };
        if (agg.analog === undefined) issues.push('Chân tín hiệu chưa nối tới ADC (A0…)');
        if (!agg.vcc) issues.push('Thiếu VCC');
        if (!agg.gnd) issues.push('Thiếu GND');
        return { ok: false, issues };
      }
      case 'lcd-i2c':
      case 'ssd1306': {
        if (agg.sda && agg.scl && agg.vcc && agg.gnd) return { ok: true, issues };
        if (!agg.sda) issues.push('Thiếu SDA');
        if (!agg.scl) issues.push('Thiếu SCL');
        if (!agg.vcc) issues.push('Thiếu VCC');
        if (!agg.gnd) issues.push('Thiếu GND');
        return { ok: false, issues };
      }
      case 'servo':
      case 'dht22':
      case 'pir':
      case 'tilt': {
        if (agg.digital !== undefined && agg.vcc && agg.gnd)
          return { ok: true, digital: agg.digital, issues };
        if (agg.digital === undefined) issues.push('Chân tín hiệu chưa nối tới GPIO');
        if (!agg.vcc) issues.push('Thiếu VCC');
        if (!agg.gnd) issues.push('Thiếu GND');
        return { ok: false, issues };
      }
      case 'ws2812': {
        const din = role('DIN').digital;
        if (din !== undefined && agg.vcc && agg.gnd) return { ok: true, digital: din, issues };
        if (din === undefined) issues.push('Chân DIN chưa nối tới GPIO');
        if (!agg.vcc) issues.push('Thiếu VCC');
        if (!agg.gnd) issues.push('Thiếu GND');
        return { ok: false, issues };
      }
      case 'hcsr04': {
        const trig = role('TRIG').digital;
        const echo = role('ECHO').digital;
        if (trig !== undefined && echo !== undefined && agg.vcc && agg.gnd)
          return { ok: true, digital: trig, issues };
        if (trig === undefined || echo === undefined)
          issues.push('Chân tín hiệu chưa nối tới GPIO');
        if (!agg.vcc) issues.push('Thiếu VCC');
        if (!agg.gnd) issues.push('Thiếu GND');
        return { ok: false, issues };
      }
      default:
        // passive (resistor) etc.: no hard gating
        return { ok: true, digital: agg.digital, analog: agg.analog, issues };
    }
  }
  /** The firmware digital pin a part drives, only if its topology is valid (else undefined → inert). */
  function controllingDigital(cid: string): number | undefined {
    const s = componentStatus(cid);
    return s.ok ? s.digital : undefined;
  }
  /** The ADC channel a part acts on, only if its topology is valid. */
  function controllingAnalog(cid: string): number | undefined {
    const s = componentStatus(cid);
    return s.ok ? s.analog : undefined;
  }

  // ── wiring (rubber-band with bend points) ────────────────────────────────────
  function cancelPending(): void {
    pendingPin.value = null;
    pendingPoints.value = [];
  }
  function clickPin(cid: string, pin: string): void {
    const start = pendingPin.value;
    if (!start) {
      pendingPin.value = { cid, pin };
      pendingPoints.value = [];
      // The pin overlay sits above the part body, so a click the user meant as "select this part" can
      // land on a pin and start a wire. Select the owning part too, so the inspector still opens (and Esc
      // cancels the pending wire) — the body/pin overlap is no longer a confusing dead-end (UX risk #2).
      if (cid !== BOARD_CID) selected.value = cid;
      return;
    }
    if (start.cid === cid && start.pin === pin) {
      cancelPending(); // clicking the origin pin again cancels
      return;
    }
    wireSeq += 1;
    wires.value.push({
      id: `w${wireSeq}`,
      from: start,
      to: { cid, pin },
      points: [...pendingPoints.value],
    });
    cancelPending();
  }
  /** Click on empty canvas: drop a bend point if wiring, else deselect. */
  /** The last committed wiring anchor (the previous bend, or the origin pin) while a wire is in flight. */
  function lastAnchor(): Point | null {
    const start = pendingPin.value;
    if (!start) return null;
    const a = pinAbs(start.cid, start.pin);
    if (!a) return null;
    return pendingPoints.value[pendingPoints.value.length - 1] ?? a;
  }
  /**
   * Snap a wiring point to the grid AND lock it onto a perpendicular/parallel line with the previous
   * anchor when it's near-aligned — the "căn vuông góc / song song" aid for clean orthogonal routing.
   */
  function snapWiringPoint(raw: Point): Point {
    const last = lastAnchor();
    let x = snap(raw.x);
    let y = snap(raw.y);
    if (last) {
      if (Math.abs(raw.x - last.x) <= GRID) x = last.x; // near-vertical → lock x (perpendicular run)
      if (Math.abs(raw.y - last.y) <= GRID) y = last.y; // near-horizontal → lock y (parallel run)
    }
    return { x, y };
  }
  function canvasDown(x: number, y: number): void {
    if (pendingPin.value) {
      pendingPoints.value.push(snapWiringPoint({ x, y })); // grid + orthogonal snap (alignment aid)
      return;
    }
    selected.value = null;
    selectedWire.value = null;
  }
  function removeWire(id: string): void {
    wires.value = wires.value.filter((w) => w.id !== id);
  }
  function clearWires(): void {
    wires.value = [];
    cancelPending();
  }
  const wireCount = computed(() => wires.value.length);

  // ── selection / transform ────────────────────────────────────────────────────
  function selectPart(cid: string | null): void {
    selected.value = cid;
  }
  function rotatePart(cid: string, dir: 1 | -1): void {
    const p = placed.value.find((q) => q.cid === cid);
    if (p) p.rot = (((p.rot + dir * ROT_STEP) % 360) + 360) % 360;
  }
  function flipPart(cid: string): void {
    const p = placed.value.find((q) => q.cid === cid);
    if (p) p.flip = !p.flip;
  }
  /** Rotate the MCU board in 90° steps (its pins + wire endpoints follow via pinAbs). */
  function rotateBoard(dir: 1 | -1): void {
    boardRot.value = (((boardRot.value + dir * BOARD_ROT_STEP) % 360) + 360) % 360;
  }
  // ── wire selection + recolour (UI only; never affects the electrical net) ─────
  function selectWire(id: string | null): void {
    selectedWire.value = id;
    if (id) selected.value = null;
  }
  function setWireColor(id: string, color: string): void {
    const w = wires.value.find((q) => q.id === id);
    if (w) w.color = color;
  }
  function removeSelectedWire(): void {
    if (selectedWire.value) {
      removeWire(selectedWire.value);
      selectedWire.value = null;
    }
  }
  /** Set an editable attribute (catalog property or the `_adc` stimulus) on a placed part. */
  function setProp(cid: string, name: string, value: PropValue): void {
    const p = placed.value.find((q) => q.cid === cid);
    if (p) p.props = { ...p.props, [name]: value };
  }
  function setColor(cid: string, color: string): void {
    setProp(cid, 'color', color);
  }
  function cycleColor(cid: string): void {
    const p = placed.value.find((q) => q.cid === cid);
    if (!p) return;
    const i = LED_COLORS.indexOf((p.props.color ?? 'red') as (typeof LED_COLORS)[number]);
    setProp(cid, 'color', LED_COLORS[(i + 1) % LED_COLORS.length]!);
  }

  // ── hover ─────────────────────────────────────────────────────────────────────
  function pinEnter(cid: string, pin: string): void {
    hover.value = { cid, pin };
  }
  function pinLeave(): void {
    hover.value = null;
  }
  const hoverLabel = computed(() => {
    const h = hover.value;
    if (!h) return null;
    const p = pinAbs(h.cid, h.pin);
    return p ? { name: h.pin, x: p.x, y: p.y } : null;
  });

  // ── derived render data ───────────────────────────────────────────────────────
  const pinDots = computed(() => {
    const dots: { cid: string; pin: string; x: number; y: number; active: boolean }[] = [];
    for (const cid of [BOARD_CID, ...placed.value.map((p) => p.cid)]) {
      for (const info of pinsPx[cid] ?? []) {
        const at = pinAbs(cid, info.name);
        if (!at) continue;
        dots.push({
          cid,
          pin: info.name,
          x: at.x,
          y: at.y,
          active:
            (pendingPin.value?.cid === cid && pendingPin.value?.pin === info.name) ||
            (hover.value?.cid === cid && hover.value?.pin === info.name),
        });
      }
    }
    return dots;
  });

  function polyline(a: Point, mids: Point[], b: Point): string {
    return [`M${a.x} ${a.y}`, ...mids.map((m) => `L${m.x} ${m.y}`), `L${b.x} ${b.y}`].join(' ');
  }
  const wirePaths = computed(() =>
    wires.value
      .map((w, i) => {
        const a = pinAbs(w.from.cid, w.from.pin);
        const b = pinAbs(w.to.cid, w.to.pin);
        if (!a || !b) return null;
        return {
          id: w.id,
          d: polyline(a, w.points, b),
          color: w.color ?? wireColor(w.from.pin, w.to.pin, i),
          selected: w.id === selectedWire.value,
          mx: w.points.length ? w.points[Math.floor(w.points.length / 2)]!.x : (a.x + b.x) / 2,
          my: w.points.length ? w.points[Math.floor(w.points.length / 2)]!.y : (a.y + b.y) / 2,
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  );

  // rubber-band: solid through committed bends, then a dashed segment to the cursor.
  const pendingSolid = computed(() => {
    const start = pendingPin.value;
    if (!start) return null;
    const a = pinAbs(start.cid, start.pin);
    if (!a) return null;
    const pts = [a, ...pendingPoints.value];
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  });
  const rubberPath = computed(() => {
    const start = pendingPin.value;
    if (!start) return null;
    const a = pinAbs(start.cid, start.pin);
    if (!a) return null;
    const last = pendingPoints.value[pendingPoints.value.length - 1] ?? a;
    const t = snapWiringPoint({ x: mouse.x, y: mouse.y }); // preview where a grid/ortho-snapped bend lands
    return `M${last.x} ${last.y} L${t.x} ${t.y}`;
  });
  const pendingName = computed(() => pendingPin.value?.pin ?? null);

  // ── zoom + coordinate conversion ──────────────────────────────────────────────
  // `canvasEl` IS the CSS-scaled content layer, so its bounding rect already reflects the zoom (and the
  // scroll position). Dividing the cursor offset by `zoom` recovers unscaled CONTENT coordinates — the
  // single conversion every pointer interaction (wire/drag/bend) routes through, so zoom can never
  // desync the hit-testing from the rendered pins.
  function clientToContent(e: { clientX: number; clientY: number }): Point {
    const rect = canvasEl.value?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (e.clientX - rect.left) / zoom.value, y: (e.clientY - rect.top) / zoom.value };
  }
  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 3;
  function setZoom(z: number): void {
    zoom.value = Math.round(clamp(z, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
  }
  function zoomBy(factor: number): void {
    setZoom(zoom.value * factor);
  }
  function resetZoom(): void {
    setZoom(1);
  }
  /** Fit the BASE_W×BASE_H content into a viewport, clamped to the zoom range (AUD-028 fit-to-container). A
   *  small margin keeps the board off the scroll edges. Pure-computed via {@link computeFitZoom} for testing. */
  function fitTo(viewW: number, viewH: number, contentW: number, contentH: number): void {
    setZoom(computeFitZoom(viewW, viewH, contentW, contentH, MIN_ZOOM, MAX_ZOOM));
  }

  // ── drag (pointer-captured on the canvas; clamped to bounds) ──────────────────
  let dragCid: string | null = null;
  let dragOff = { x: 0, y: 0 };
  /** Content width/height (the un-scaled layer box) used to clamp a dragged part on-canvas. */
  function contentSize(): { w: number; h: number } {
    const rect = canvasEl.value?.getBoundingClientRect();
    return rect ? { w: rect.width / zoom.value, h: rect.height / zoom.value } : { w: 0, h: 0 };
  }
  function startDrag(e: PointerEvent, cid: string): void {
    selected.value = cid;
    selectedWire.value = null;
    if (!canvasEl.value) return;
    const origin = cid === BOARD_CID ? boardPos : placed.value.find((q) => q.cid === cid);
    if (!origin) return;
    dragCid = cid;
    const c = clientToContent(e);
    dragOff = { x: c.x - origin.x, y: c.y - origin.y };
    canvasEl.value.setPointerCapture?.(e.pointerId);
  }
  function onDrag(e: PointerEvent): void {
    if (dragCid === null || !canvasEl.value) return;
    const target = dragCid === BOARD_CID ? boardPos : placed.value.find((q) => q.cid === dragCid);
    if (!target) return;
    const c = clientToContent(e);
    const { w, h } = contentSize();
    target.x = clamp(Math.round(c.x - dragOff.x), 0, w - PART_MARGIN);
    target.y = clamp(Math.round(c.y - dragOff.y), 0, h - PART_MARGIN);
  }
  function endDrag(): void {
    dragCid = null;
  }
  /** Canvas pointer-move: track the cursor (rubber-band) and forward to the active part drag. */
  function onMove(e: PointerEvent): void {
    const c = clientToContent(e);
    mouse.x = c.x;
    mouse.y = c.y;
    onDrag(e);
  }

  return {
    // state
    placed,
    wires,
    pendingPin,
    pendingPoints,
    hover,
    selected,
    selectedWire,
    mouse,
    boardPos,
    boardRot,
    zoom,
    clientToContent,
    zoomBy,
    resetZoom,
    fitTo,
    // parts
    addPart,
    removePart,
    refreshPin,
    refreshAll,
    boardLayout,
    boardOrigin,
    selectPart,
    rotatePart,
    flipPart,
    rotateBoard,
    setProp,
    setColor,
    cycleColor,
    // wiring
    clickPin,
    canvasDown,
    removeWire,
    clearWires,
    cancelPending,
    wireCount,
    selectWire,
    setWireColor,
    removeSelectedWire,
    // net trace + electrical-topology truth
    resolvePin,
    controllingDigital,
    controllingAnalog,
    componentStatus,
    // hover
    pinEnter,
    pinLeave,
    hoverLabel,
    // derived
    pinDots,
    wirePaths,
    pendingSolid,
    rubberPath,
    pendingName,
    // drag
    startDrag,
    onDrag,
    endDrag,
    onMove,
  };
}
