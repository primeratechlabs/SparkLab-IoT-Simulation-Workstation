/**
 * Compile a drawn document DOWN to the simulator's logical netlist (sim-kernel) and run the
 * Electrical Rule Checker on it. This is the truth handoff: the canvas is a drawing, but ERC and
 * the kernel reason over nets. Nets come from the net graph; the VCC/GND rails are derived from the
 * board's power pins; each placed part maps to a NetlistComponent (kind + ohms / I2C address).
 */
import type { ErcFinding, Netlist, NetlistComponent, NetlistNet } from '@sparklab/sim-kernel';
import { runErc } from '@sparklab/sim-kernel';
import type { CircuitDocument, PropValue } from './types.js';
import { MCU_REF } from './types.js';
import { coerceNum } from './coerce.js';
import { catalogEntry } from './catalog.js';
import { boardEntry } from './board.js';
import { NetGraph } from './netgraph.js';

export interface NetlistResult {
  netlist: Netlist;
  erc: ErcFinding[];
}

// Delegates to the shared coercion (coerce.ts) so it never drifts from the catalog's.
function numProp(props: Record<string, PropValue>, key: string, dflt: number): number {
  return coerceNum(props, key, dflt);
}

function netIdContaining(
  nets: NetlistNet[],
  component: string,
  pin: string | undefined,
): string | undefined {
  if (!pin) return undefined;
  return nets.find((n) => n.pins.some((p) => p.component === component && p.pin === pin))?.id;
}

/** Build the logical netlist + ERC findings from a circuit document. */
export function documentToNetlist(doc: CircuitDocument): NetlistResult {
  const graph = new NetGraph(doc);
  const nets: NetlistNet[] = graph.nets().map((pins, i) => ({
    id: `net${i}`,
    pins: pins.map((p) => ({ component: p.component, pin: p.pin })),
  }));

  const board = boardEntry(doc.board.id);
  const vccNet = netIdContaining(nets, MCU_REF, board?.vccPin) ?? '__vcc__';
  const gndNet = netIdContaining(nets, MCU_REF, board?.gndPin) ?? '__gnd__';

  // The MCU carries no pinModes here: pin direction is a firmware/runtime property, not knowable
  // from the drawn document — so the ERC floating-input rule stays inert for document-derived
  // netlists (it activates only for firmware-backed netlists that supply pinModes).
  const components: NetlistComponent[] = [{ id: MCU_REF, kind: 'mcu' }];
  for (const c of doc.components) {
    const entry = catalogEntry(c.type);
    if (!entry) continue;
    const nc: NetlistComponent = { id: c.id, kind: entry.kind };
    if (entry.kind === 'resistor') nc.ohms = numProp(c.props, 'ohms', 220);
    const addr = entry.i2cAddress?.(c.props);
    if (addr !== undefined) nc.address = addr;
    components.push(nc);
  }

  const netlist: Netlist = { components, nets, vccNet, gndNet };
  const erc = runErc(netlist);

  // Over-voltage: ESP32 logic is 3.3V-tolerant only, so the board's 5V rail must not reach one of its
  // 3.3V GPIO pins (a classic curriculum mistake that fries the chip). AVR (5V logic) is exempt. (CMB-10)
  if (board && board.architecture !== 'avr') {
    const fiveVNet = netIdContaining(nets, MCU_REF, '5V');
    if (fiveVNet) {
      // Any 3.3V-logic SIGNAL pin (GPIO-capable: a digital pin OR an input-only ADC pin like the
      // ESP32's VP/VN/D34/D35) is damaged by 5V — gate on pin CAPABILITY, not the drawn pin `type`
      // (which mislabels input-only ADC pins as 'analog' and would skip them).
      const gpioPins = new Set(
        board.pins
          .filter((p) => p.digitalPin !== undefined || p.adcChannel !== undefined)
          .map((p) => p.name),
      );
      const net = nets.find((n) => n.id === fiveVNet)!;
      const offenders = net.pins
        .filter((p) => p.component === MCU_REF && gpioPins.has(p.pin))
        .map((p) => p.pin);
      if (offenders.length) {
        erc.push({
          rule: 'over-voltage',
          severity: 'error',
          message: `Chân ${offenders.join(', ')} (GPIO 3.3V) nối vào rail 5V — quá áp, có thể hỏng ${board.displayName}`,
          refs: [MCU_REF, fiveVNet],
        });
      }
    }
  }

  return { netlist, erc };
}
