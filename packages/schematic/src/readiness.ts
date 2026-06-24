/**
 * Component electrical-readiness — the single source of truth for "is this part wired correctly enough
 * to act?" used by BOTH the headless runtime (instantiate gates on it) and the canvas product layer
 * (which delegates to it via a derived CircuitDocument). It works off the catalog pin TYPES + the
 * NetGraph: a ground pin must reach the board GND, a power pin the board VCC, an I2C pin its bus line,
 * and a signal pin must resolve to an MCU pin. LEDs (and RGB LEDs) get a polarity-aware special case
 * because their two "digital" legs are an anode (driven) and a cathode (return to GND).
 */
import type { CircuitDocument } from './types.js';
import { MCU_REF } from './types.js';
import { catalogEntry } from './catalog.js';
import { boardPin, type BoardPin } from './board.js';
import { NetGraph, resolveDigital, resolveAnalog } from './netgraph.js';

export interface ReadinessStatus {
  /** Topology is valid → the part may reflect/drive the firmware. */
  ok: boolean;
  /** The MCU digital pin it acts on (when valid). */
  digital?: number;
  /** The ADC channel it acts on (when valid). */
  analog?: number;
  /** Human-readable wiring problems (missing GND, reversed polarity, missing bus, …). */
  issues: string[];
}

function reaches(
  graph: NetGraph,
  doc: CircuitDocument,
  compId: string,
  pin: string,
  pred: (bp: BoardPin | undefined) => boolean,
): boolean {
  return graph
    .netOf({ component: compId, pin })
    .some((p) => p.component === MCU_REF && pred(boardPin(doc.board.id, p.pin)));
}

function statusFor(
  graph: NetGraph,
  doc: CircuitDocument,
  compId: string,
  type: string,
): ReadinessStatus {
  const entry = catalogEntry(type);
  if (!entry) return { ok: false, issues: ['Loại linh kiện không xác định'] };
  if (entry.kind === 'resistor') return { ok: true, issues: [] }; // passive: netlist-only, always "ready"

  const gnd = (pin: string): boolean =>
    reaches(graph, doc, compId, pin, (bp) => bp?.type === 'ground');
  const pwr = (pin: string): boolean =>
    reaches(graph, doc, compId, pin, (bp) => bp?.type === 'power');
  const sda = (pin: string): boolean => reaches(graph, doc, compId, pin, (bp) => bp?.i2c === 'SDA');
  const scl = (pin: string): boolean => reaches(graph, doc, compId, pin, (bp) => bp?.i2c === 'SCL');
  const dig = (pin: string): number | undefined => resolveDigital(graph, doc, compId, pin);
  const ana = (pin: string): number | undefined => resolveAnalog(graph, doc, compId, pin);

  // LED: anode drives, cathode returns to GND (polarity-aware).
  if (entry.kind === 'led') {
    const anode = dig('anode');
    if (anode !== undefined && gnd('cathode')) return { ok: true, digital: anode, issues: [] };
    if (dig('cathode') !== undefined && gnd('anode'))
      return { ok: false, issues: ['LED đảo cực (anode/cathode ngược)'] };
    if (anode !== undefined) return { ok: false, issues: ['Cathode chưa nối GND'] };
    return { ok: false, issues: ['Chưa nối đủ (anode → chân số, cathode → GND)'] };
  }
  if (entry.kind === 'rgb-led') {
    const anyChannel = ['r', 'g', 'b'].some((n) => dig(n) !== undefined);
    const common = gnd('common') || pwr('common');
    const issues: string[] = [];
    if (!anyChannel) issues.push('Chưa nối kênh R/G/B tới chân điều khiển');
    if (!common) issues.push('Chân chung (COM) chưa nối GND/VCC');
    return { ok: issues.length === 0, issues };
  }
  // WS2812/NeoPixel: DIN is the driven input, VCC + GND are required; DOUT (chain-out) is optional.
  if (entry.kind === 'ws2812') {
    const din = dig('din');
    const issues: string[] = [];
    if (din === undefined) issues.push('Chân DIN chưa nối tới GPIO');
    if (!pwr('vcc')) issues.push('Thiếu VCC');
    if (!gnd('gnd')) issues.push('Thiếu GND');
    return { ok: issues.length === 0, digital: din, issues };
  }

  // Generic: every pin must satisfy its catalog role.
  const issues = new Set<string>();
  let digital: number | undefined;
  let analog: number | undefined;
  for (const p of entry.pins) {
    switch (p.type) {
      case 'ground':
        if (!gnd(p.name)) issues.add('Thiếu GND');
        break;
      case 'power':
        if (!pwr(p.name)) issues.add('Thiếu VCC');
        break;
      case 'i2c-sda':
        if (!sda(p.name)) issues.add('Thiếu SDA');
        break;
      case 'i2c-scl':
        if (!scl(p.name)) issues.add('Thiếu SCL');
        break;
      case 'digital': {
        const r = dig(p.name);
        if (r === undefined) issues.add('Chân tín hiệu chưa nối tới GPIO');
        else digital ??= r;
        break;
      }
      case 'analog': {
        const r = ana(p.name);
        if (r === undefined) issues.add('Chân tín hiệu chưa nối tới ADC (A0…)');
        else analog ??= r;
        break;
      }
    }
  }
  return { ok: issues.size === 0, digital, analog, issues: [...issues] };
}

/** Readiness of every placed component, keyed by component id. */
export function componentReadiness(doc: CircuitDocument): Map<string, ReadinessStatus> {
  const graph = new NetGraph(doc);
  const out = new Map<string, ReadinessStatus>();
  for (const c of doc.components) out.set(c.id, statusFor(graph, doc, c.id, c.type));
  return out;
}
