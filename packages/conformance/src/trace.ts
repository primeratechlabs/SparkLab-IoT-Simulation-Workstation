/**
 * Conformance trace comparison — REFERENCE-SPEC §18 (gate #7). A golden trace is an
 * ordered list of observable events (GPIO edges, UART bytes, I2C transactions) with
 * virtual-time timestamps. `compareTraces` diffs a recorded trace against a reference
 * with a time tolerance, so a sketch run on the simulator can be validated against an
 * expected trace. Until a hardware calibration rig exists the references are
 * simulator-generated and marked UNCALIBRATED in the fidelity ledger (invariant I7).
 */

export interface TraceEvent {
  /** Virtual time in nanoseconds. */
  tNs: number;
  /** Event kind, e.g. 'gpio', 'uart', 'i2c'. */
  kind: string;
  /** Stable identity within the kind (pin number, bus address, byte value…). */
  key: string;
}

export type Trace = TraceEvent[];

export interface CompareOptions {
  /** Allowed timing slack per event (default 1ms of virtual time). */
  timeToleranceNs?: number;
  /** Ignore absolute time, compare only ordering + key (default false). */
  orderingOnly?: boolean;
}

export interface TraceMismatch {
  index: number;
  reason: 'missing' | 'extra' | 'kind' | 'key' | 'timing';
  expected?: TraceEvent;
  actual?: TraceEvent;
  detail: string;
}

export interface TraceDiff {
  ok: boolean;
  matched: number;
  mismatches: TraceMismatch[];
}

/** Compare a recorded trace against a reference. Events are matched positionally. */
export function compareTraces(
  reference: Trace,
  actual: Trace,
  opts: CompareOptions = {},
): TraceDiff {
  const tol = opts.timeToleranceNs ?? 1_000_000;
  const mismatches: TraceMismatch[] = [];
  let matched = 0;

  const n = Math.max(reference.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = reference[i];
    const a = actual[i];
    if (!e) {
      mismatches.push({
        index: i,
        reason: 'extra',
        actual: a,
        detail: `unexpected ${a!.kind}:${a!.key}`,
      });
      continue;
    }
    if (!a) {
      mismatches.push({
        index: i,
        reason: 'missing',
        expected: e,
        detail: `missing ${e.kind}:${e.key}`,
      });
      continue;
    }
    if (a.kind !== e.kind) {
      mismatches.push({
        index: i,
        reason: 'kind',
        expected: e,
        actual: a,
        detail: `kind ${a.kind} ≠ ${e.kind}`,
      });
      continue;
    }
    if (a.key !== e.key) {
      mismatches.push({
        index: i,
        reason: 'key',
        expected: e,
        actual: a,
        detail: `key ${a.key} ≠ ${e.key}`,
      });
      continue;
    }
    if (!opts.orderingOnly && Math.abs(a.tNs - e.tNs) > tol) {
      mismatches.push({
        index: i,
        reason: 'timing',
        expected: e,
        actual: a,
        detail: `Δt ${a.tNs - e.tNs}ns > ${tol}ns`,
      });
      continue;
    }
    matched++;
  }

  return { ok: mismatches.length === 0, matched, mismatches };
}
