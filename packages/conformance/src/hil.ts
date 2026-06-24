/**
 * Stage 7 — Hardware-in-the-loop (HIL) calibration harness. This is the agent's half of the
 * `[CI/HUMAN]` conformance rig: the code + format to compare a simulator trace against a trace
 * MEASURED on real silicon (logic analyzer / scope / serial), and to flip a fidelity-ledger entry
 * from uncalibrated → calibrated once it matches. The human half — flashing the standard lab
 * sketches on real boards and recording traces — is documented in docs/HIL-CALIBRATION.md.
 *
 * Pure: no I/O, no wall-clock (the recording timestamp is supplied by the operator), so it runs in
 * CI against fixtures and reproduces exactly.
 */
import { compareTraces, type Trace, type CompareOptions } from './trace.js';
import { type ConformanceLab, type FidelityGrade } from './fidelity-ledger.js';

/** A trace measured on REAL hardware (the human supplies this). */
export interface HardwareTrace {
  lab: string;
  trace: Trace;
  board: string; // "arduino-uno" | "esp32-devkit" | "esp32-c3-devkit"
  instrument: string; // "saleae-logic" | "oscilloscope" | "serial-capture"
  recordedAt: string; // ISO date supplied by the operator (NOT generated here)
  notes?: string;
}

export interface CalibrationResult {
  lab: string;
  board: string;
  /** True when the simulator trace matches the hardware trace within tolerance. */
  calibrated: boolean;
  matched: number;
  mismatches: number;
  /** The fidelity grade this calibration supports: A (tight match) / A- (within slack) / B (diverges). */
  supportedGrade: FidelityGrade;
  detail: string;
}

const TIGHT_TOLERANCE_NS = 50_000; // 50 µs — an A-grade match must be this tight

/** Calibrate a lab by comparing the simulator's trace against a recorded hardware trace. */
export function calibrateLab(
  simTrace: Trace,
  hw: HardwareTrace,
  opts: CompareOptions = {},
): CalibrationResult {
  const diff = compareTraces(hw.trace, simTrace, opts);
  const tol = opts.timeToleranceNs ?? 1_000_000;
  const supportedGrade: FidelityGrade = !diff.ok ? 'B' : tol <= TIGHT_TOLERANCE_NS ? 'A' : 'A-';
  return {
    lab: hw.lab,
    board: hw.board,
    calibrated: diff.ok,
    matched: diff.matched,
    mismatches: diff.mismatches.length,
    supportedGrade,
    detail: diff.ok
      ? `sim matches ${hw.board} (${diff.matched} events within ${tol}ns)`
      : `DIVERGES from ${hw.board}: ${
          diff.mismatches
            .slice(0, 3)
            .map((m) => m.detail)
            .join('; ') || 'length/order mismatch'
        }`,
  };
}

/**
 * Apply a passing calibration to a ledger entry — flip `calibrated` and adopt the supported grade,
 * annotating with the board it was measured against. A failing calibration leaves the entry as-is
 * (we never over-claim: a divergent sim stays uncalibrated).
 */
export function applyCalibration(entry: ConformanceLab, result: CalibrationResult): ConformanceLab {
  if (!result.calibrated) return entry;
  return {
    ...entry,
    calibrated: true,
    grade: result.supportedGrade,
    note: `${entry.note} [calibrated vs ${result.board}, grade ${result.supportedGrade}]`,
  };
}
