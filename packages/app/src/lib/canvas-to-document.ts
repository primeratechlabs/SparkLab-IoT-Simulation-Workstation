/**
 * Canvas → CircuitDocument bridge (P1-5). Projects the canvas's wokwi-named `placed/wires` onto the
 * schematic's catalog-named `CircuitDocument`, so the product can run the SAME truth engine
 * (NetGraph / ERC / componentReadiness) the headless layer uses — no second electrical implementation.
 *
 * The only thing this layer owns is the NAME reconciliation: wokwi pin names (A/C, 1/2, SIG, AO, "13")
 * ↔ catalog pin names (anode/cathode, a/b, wiper, sig, "D13"). A few elements have no clean mapping
 * yet (relay ks2e contacts, the SPI ssd1306 element vs the I2C catalog) — their unmapped pins pass
 * through and simply don't resolve, which is honest until those component models are reconciled.
 */
import {
  breadboardGroupOf,
  componentPinAlias,
  emptyDocument,
  MCU_REF,
  type CircuitDocument,
  type PinRef,
} from '@sparklab/schematic';
import { BOARD_CID, type Placed, type CanvasWire } from '../composables/useCircuitCanvas';

/** wokwi board header name → catalog board pin name (Uno bare numbers gain a "D"; GND.x → GND). */
export function aliasBoardPin(name: string): string {
  if (/^GND/.test(name)) return 'GND';
  if (name === '3.3V') return '3V3';
  if (/^[0-9]+$/.test(name)) return `D${name}`;
  return name; // D13 / A0 / TX0 / VP / GPIO8 / 5V / VIN …
}

/** A drawn wire endpoint that could not be reconciled to a catalog pin — so the wire is NOT in the runtime
 *  netlist. AUD-003: surfaced as a structured diagnostic instead of being dropped silently. */
export interface UnmappedEndpoint {
  wireId: string;
  endpoint: 'from' | 'to';
  cid: string;
  pin: string;
  reason: 'unknown-component' | 'pin-has-no-catalog-equivalent';
}

/**
 * Project the canvas onto the schematic CircuitDocument (the truth engine's only input) AND report every
 * wire endpoint that failed to map. A drawn wire that doesn't reach the netlist means the circuit the user
 * SEES differs from what runs — the caller must show these `unmapped` diagnostics and refuse to treat the
 * device as connected (no silent drop). Rotation stays 0 here: it is visual-only (the canvas snapshot owns
 * it; it does not change the netlist), and the schema accepts only 0/90/180/270 — see AUD-003 notes.
 */
export function projectCanvas(
  placed: Placed[],
  wires: CanvasWire[],
  boardId: string,
): { doc: CircuitDocument; unmapped: UnmappedEndpoint[] } {
  const doc = emptyDocument('canvas', 'canvas', { boardId, now: 0 });
  const typeOf = new Map(placed.map((p) => [p.cid, p.type]));
  for (const p of placed)
    doc.components.push({
      id: p.cid,
      type: p.type,
      x: p.x,
      y: p.y,
      rotation: 0,
      props: { ...p.props },
    });

  const ref = (cid: string, pin: string): { ok: PinRef } | { fail: UnmappedEndpoint['reason'] } => {
    if (cid === BOARD_CID) return { ok: { component: MCU_REF, pin: aliasBoardPin(pin) } };
    const type = typeOf.get(cid);
    if (!type) return { fail: 'unknown-component' };
    // Breadboard: a hole resolves to the NET GROUP it belongs to, so two pins plugged into the same
    // group (a column half, or a power rail) share one net node — the row-net wiring with no explicit wire.
    if (type === 'breadboard') return { ok: { component: cid, pin: breadboardGroupOf(pin) } };
    const map = componentPinAlias(type);
    if (!map) return { ok: { component: cid, pin } }; // unmapped type → pass the wokwi name through
    const aliased = map[pin];
    return aliased
      ? { ok: { component: cid, pin: aliased } }
      : { fail: 'pin-has-no-catalog-equivalent' };
  };

  const unmapped: UnmappedEndpoint[] = [];
  for (const w of wires) {
    const from = ref(w.from.cid, w.from.pin);
    const to = ref(w.to.cid, w.to.pin);
    if ('fail' in from)
      unmapped.push({
        wireId: w.id,
        endpoint: 'from',
        cid: w.from.cid,
        pin: w.from.pin,
        reason: from.fail,
      });
    if ('fail' in to)
      unmapped.push({
        wireId: w.id,
        endpoint: 'to',
        cid: w.to.cid,
        pin: w.to.pin,
        reason: to.fail,
      });
    if ('ok' in from && 'ok' in to) doc.wires.push({ id: w.id, from: from.ok, to: to.ok });
  }
  return { doc, unmapped };
}

/** Backward-compatible projection (document only) — callers that want the unmapped diagnostics use
 *  {@link projectCanvas}. */
export function canvasToDocument(
  placed: Placed[],
  wires: CanvasWire[],
  boardId: string,
): CircuitDocument {
  return projectCanvas(placed, wires, boardId).doc;
}
