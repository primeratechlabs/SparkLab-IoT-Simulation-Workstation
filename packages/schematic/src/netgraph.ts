/**
 * Net graph — turns the document's wires into electrical nets (union-find over pins) and resolves a
 * component pin to the Arduino pin NUMBER / ADC channel it controls. Resolution follows the net,
 * and ALSO hops through a single series resistor, because the breadboard idiom is
 * MCU-pin → resistor → LED: the LED's controlling pin is one passive hop away. This is the bridge
 * from "what the user drew" to "what components-core needs" (numeric pins).
 */
import type { CircuitDocument, PinRef } from './types.js';
import { MCU_REF } from './types.js';
import { catalogEntry } from './catalog.js';
import { boardPin } from './board.js';

const SEP = String.fromCharCode(0); // NUL separator - invalid in real ids, so (component,pin) keys never collide
const keyOf = (r: PinRef): string => r.component + SEP + r.pin;
function unkey(k: string): PinRef {
  const i = k.indexOf(SEP);
  return { component: k.slice(0, i), pin: k.slice(i + 1) };
}
const cmp = (a: PinRef, b: PinRef): number => keyOf(a).localeCompare(keyOf(b));
const sortPins = (pins: PinRef[]): PinRef[] => [...pins].sort(cmp);

export class NetGraph {
  private parent = new Map<string, string>();
  private cache: PinRef[][] | null = null;

  constructor(doc: CircuitDocument) {
    for (const w of doc.wires) this.union(keyOf(w.from), keyOf(w.to));
  }

  private ensure(k: string): void {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  private find(k: string): string {
    this.ensure(k);
    let root = k;
    while (this.parent.get(root)! !== root) root = this.parent.get(root)!;
    let cur = k;
    while (this.parent.get(cur)! !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  private union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
    this.cache = null;
  }

  /** All pins sharing a net with `ref` (includes `ref`); an unwired pin returns just itself. */
  netOf(ref: PinRef): PinRef[] {
    const k = keyOf(ref);
    if (!this.parent.has(k)) return [ref];
    const root = this.find(k);
    const out: PinRef[] = [];
    for (const kk of this.parent.keys()) if (this.find(kk) === root) out.push(unkey(kk));
    return sortPins(out);
  }

  /** Every net (each a sorted PinRef[]), deterministically ordered for reproducible netlists. */
  nets(): PinRef[][] {
    if (this.cache) return this.cache;
    const groups = new Map<string, PinRef[]>();
    for (const kk of this.parent.keys()) {
      const root = this.find(kk);
      let g = groups.get(root);
      if (!g) {
        g = [];
        groups.set(root, g);
      }
      g.push(unkey(kk));
    }
    const nets = [...groups.values()].map(sortPins);
    nets.sort((a, b) => cmp(a[0]!, b[0]!));
    this.cache = nets;
    return nets;
  }
}

type PinClass = 'digital' | 'analog';

function mcuPinNumber(doc: CircuitDocument, pins: PinRef[], cls: PinClass): number | undefined {
  for (const p of pins) {
    if (p.component !== MCU_REF) continue;
    const bp = boardPin(doc.board.id, p.pin);
    if (!bp) continue;
    const n = cls === 'digital' ? bp.digitalPin : bp.adcChannel;
    if (n !== undefined) return n;
  }
  return undefined;
}

function resolve(
  graph: NetGraph,
  doc: CircuitDocument,
  compId: string,
  pinName: string,
  cls: PinClass,
): number | undefined {
  const net = graph.netOf({ component: compId, pin: pinName });
  const direct = mcuPinNumber(doc, net, cls);
  if (direct !== undefined) return direct;
  // one series-resistor hop: MCU → resistor → this component. If a hopped net has more than one MCU
  // pin (an ambiguous topology / user wiring error), the first in sorted order wins — deterministic,
  // though such a circuit is itself ill-defined.
  for (const p of net) {
    if (p.component === MCU_REF) continue;
    const comp = doc.components.find((c) => c.id === p.component);
    if (!comp || catalogEntry(comp.type)?.kind !== 'resistor') continue;
    for (const other of catalogEntry(comp.type)!.pins) {
      if (other.name === p.pin) continue;
      const found = mcuPinNumber(doc, graph.netOf({ component: comp.id, pin: other.name }), cls);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Arduino digital pin number controlling `compId.pinName` (≤1 resistor hop), or undefined. */
export function resolveDigital(
  graph: NetGraph,
  doc: CircuitDocument,
  compId: string,
  pinName: string,
): number | undefined {
  return resolve(graph, doc, compId, pinName, 'digital');
}

/** ADC channel feeding `compId.pinName`, or undefined. */
export function resolveAnalog(
  graph: NetGraph,
  doc: CircuitDocument,
  compId: string,
  pinName: string,
): number | undefined {
  return resolve(graph, doc, compId, pinName, 'analog');
}
