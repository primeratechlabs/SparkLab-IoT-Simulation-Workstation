/**
 * Analog engine — REFERENCE-SPEC Stage 3 (`analog-lite` + `dc-solver`). A small DC
 * resistive nodal solver (Gaussian elimination on the conductance matrix) that runs
 * only when the analog topology changes, giving correct divider voltages for pots,
 * LDRs and NTCs feeding the ADC. NOT full SPICE — resistors + fixed-voltage nodes
 * only (no reactive/nonlinear elements), which is all the MVP needs.
 */

export interface Resistor {
  a: string;
  b: string;
  ohms: number;
}

export interface ResistiveNetwork {
  /** Nodes pinned to a known voltage (e.g. VCC=5, GND=0). */
  fixed: Record<string, number>;
  resistors: Resistor[];
}

/**
 * Solve for every node voltage. Fixed nodes keep their value; unknown nodes are
 * found by nodal analysis (KCL). Returns volts per node. A node with no path to a
 * fixed node is reported as 0 (floating — the caller/ERC can flag it).
 */
export function solveResistiveNetwork(net: ResistiveNetwork): Record<string, number> {
  const unknowns: string[] = [];
  const index = new Map<string, number>();
  const allNodes = new Set<string>(Object.keys(net.fixed));
  for (const r of net.resistors) {
    allNodes.add(r.a);
    allNodes.add(r.b);
  }
  for (const n of allNodes) {
    if (!(n in net.fixed)) {
      index.set(n, unknowns.length);
      unknowns.push(n);
    }
  }

  const n = unknowns.length;
  const out: Record<string, number> = { ...net.fixed };
  if (n === 0) return out;

  // G·v = b (conductance matrix). Tiny guard ohms avoids divide-by-zero shorts.
  const G: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const b: number[] = new Array(n).fill(0);
  for (const r of net.resistors) {
    const g = 1 / Math.max(r.ohms, 1e-9);
    const ia = index.get(r.a);
    const ib = index.get(r.b);
    if (ia !== undefined) G[ia]![ia]! += g;
    if (ib !== undefined) G[ib]![ib]! += g;
    if (ia !== undefined && ib !== undefined) {
      G[ia]![ib]! -= g;
      G[ib]![ia]! -= g;
    } else if (ia !== undefined && ib === undefined) {
      b[ia]! += g * net.fixed[r.b]!; // fixed neighbour contributes to RHS
    } else if (ib !== undefined && ia === undefined) {
      b[ib]! += g * net.fixed[r.a]!;
    }
  }

  const v = gaussianSolve(G, b);
  for (let i = 0; i < n; i++) out[unknowns[i]!] = v[i] ?? 0;
  return out;
}

/** Gaussian elimination with partial pivoting. Returns 0 for unsolvable rows. */
function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-12) continue; // singular column → leave as 0
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    const pv = M[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]! / pv;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= factor * M[col]![c]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

/** A potentiometer as a divider: VCC ─Rtop─ wiper ─Rbottom─ GND, position 0..1. */
export function potentiometerWiperVolts(vcc: number, totalOhms: number, position: number): number {
  const p = Math.max(0, Math.min(1, position));
  // Clamp to a tiny positive resistance: a 0 or negative track would otherwise yield a
  // meaningless divider (negative ohms passes the `|| 1e-6` guard, which only fires on 0).
  const total = Math.max(totalOhms, 1e-6);
  const result = solveResistiveNetwork({
    fixed: { VCC: vcc, GND: 0 },
    resistors: [
      { a: 'VCC', b: 'W', ohms: total * (1 - p) || 1e-6 },
      { a: 'W', b: 'GND', ohms: total * p || 1e-6 },
    ],
  });
  return result.W ?? 0;
}

/** Convert a node voltage to an ADC raw reading (default Uno: 10-bit @ 5V ref). */
export function voltageToAdc(volts: number, vref = 5, bits = 10): number {
  const max = (1 << bits) - 1;
  return Math.max(0, Math.min(max, Math.round((volts / vref) * max)));
}
