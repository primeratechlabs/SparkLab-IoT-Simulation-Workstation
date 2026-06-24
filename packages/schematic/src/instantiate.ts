/**
 * Instantiate runnable components from a document, and assemble a ready-to-run Circuit. This is the
 * payoff of the whole package: a circuit the user DREW becomes live `SimComponent`s wired to the
 * right MCU pins (resolved via the net graph) and added to a `@sparklab/circuit` Circuit that runs
 * the firmware. Passive parts (resistors) contribute to the netlist but produce no instance; a part
 * whose required MCU pin can't be resolved is reported as an issue rather than silently dropped.
 */
import type { SimComponent } from '@sparklab/components-core';
import { Circuit, type CircuitOptions } from '@sparklab/circuit';
import type { CircuitDocument } from './types.js';
import { catalogEntry, type BuildContext } from './catalog.js';
import { boardEntry } from './board.js';
import { NetGraph, resolveDigital, resolveAnalog } from './netgraph.js';
import { componentReadiness } from './readiness.js';

export interface InstantiateIssue {
  componentId: string;
  type: string;
  reason: string;
}

export interface InstantiateResult {
  components: SimComponent[];
  issues: InstantiateIssue[];
}

/** Turn a document's placed components into runnable SimComponents (resistors are netlist-only). */
export function instantiateComponents(doc: CircuitDocument): InstantiateResult {
  const graph = new NetGraph(doc);
  const readiness = componentReadiness(doc);
  const components: SimComponent[] = [];
  const issues: InstantiateIssue[] = [];

  for (const c of doc.components) {
    const entry = catalogEntry(c.type);
    if (!entry) {
      issues.push({ componentId: c.id, type: c.type, reason: 'unknown component type' });
      continue;
    }
    // Electrical-topology gate: an invalid circuit (no GND return, reversed LED, missing rail/bus)
    // is NOT instantiated — it reports its wiring issue instead of silently "working".
    const ready = readiness.get(c.id);
    if (entry.kind !== 'resistor' && ready && !ready.ok) {
      issues.push({
        componentId: c.id,
        type: c.type,
        reason: ready.issues.join('; ') || 'invalid topology',
      });
      continue;
    }
    const ctx: BuildContext = {
      id: c.id,
      props: c.props,
      digital: (pin) => resolveDigital(graph, doc, c.id, pin),
      analog: (pin) => resolveAnalog(graph, doc, c.id, pin),
    };
    const sim = entry.build(ctx);
    if (sim) {
      components.push(sim);
    } else if (entry.kind !== 'resistor') {
      issues.push({
        componentId: c.id,
        type: c.type,
        reason: 'could not resolve its required MCU pin(s)',
      });
    }
  }

  return { components, issues };
}

export interface BuiltCircuit {
  circuit: Circuit;
  issues: InstantiateIssue[];
}

/**
 * Build a runnable Circuit from a document + firmware: instantiate components and add them.
 * Only AVR boards run today (@sparklab/circuit is the Uno engine); an ESP32 document needs the
 * rv32/Xtensa run harness (not yet wired) and throws here rather than running on the wrong CPU.
 */
export function buildCircuit(
  doc: CircuitDocument,
  firmware: Uint8Array,
  opts?: CircuitOptions,
): BuiltCircuit {
  const board = boardEntry(doc.board.id);
  if (board && board.architecture !== 'avr') {
    throw new Error(
      `buildCircuit runs AVR boards only; '${doc.board.id}' (${board.architecture}) needs its own run harness`,
    );
  }
  const { components, issues } = instantiateComponents(doc);
  const circuit = new Circuit(firmware, opts ?? {});
  for (const c of components) circuit.add(c);
  return { circuit, issues };
}
