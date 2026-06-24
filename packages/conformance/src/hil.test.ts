import { describe, it, expect } from 'vitest';
import { calibrateLab, applyCalibration, type HardwareTrace } from './hil.js';
import { ledgerFor, type ConformanceLab } from './fidelity-ledger.js';
import type { Trace } from './trace.js';

/**
 * HIL calibration harness — the agent's half of the `[CI/HUMAN]` rig. These tests pin the
 * comparison + ledger-flip logic against fixtures so it reproduces in CI; the human supplies real
 * `HardwareTrace`s later (see docs/HIL-CALIBRATION.md). Run ×3 to prove determinism.
 */

// blink_timing: GPIO13 toggles at 1 Hz — HIGH at 0ms, LOW at 500ms, HIGH at 1000ms.
const blinkRef: Trace = [
  { tNs: 0, kind: 'gpio', key: '13=1' },
  { tNs: 500_000_000, kind: 'gpio', key: '13=0' },
  { tNs: 1_000_000_000, kind: 'gpio', key: '13=1' },
];

function hwTrace(trace: Trace): HardwareTrace {
  return {
    lab: 'blink_timing',
    trace,
    board: 'arduino-uno',
    instrument: 'saleae-logic',
    recordedAt: '2026-06-18T00:00:00Z',
  };
}

for (let round = 1; round <= 3; round++) {
  describe(`HIL calibrateLab (round ${round})`, () => {
    it('calibrates a lab when the sim matches hardware within the default 1ms slack', () => {
      // sim is 200µs late on the second edge — inside 1ms slack
      const sim: Trace = [
        { tNs: 0, kind: 'gpio', key: '13=1' },
        { tNs: 500_200_000, kind: 'gpio', key: '13=0' },
        { tNs: 1_000_000_000, kind: 'gpio', key: '13=1' },
      ];
      const r = calibrateLab(sim, hwTrace(blinkRef));
      expect(r.calibrated).toBe(true);
      expect(r.matched).toBe(3);
      expect(r.mismatches).toBe(0);
      expect(r.supportedGrade).toBe('A-'); // default tolerance → A-, not A
      expect(r.detail).toContain('arduino-uno');
    });

    it('awards grade A only under a tight (≤50µs) tolerance match', () => {
      const r = calibrateLab(blinkRef, hwTrace(blinkRef), { timeToleranceNs: 50_000 });
      expect(r.calibrated).toBe(true);
      expect(r.supportedGrade).toBe('A');
    });

    it('refuses to calibrate when the sim diverges from hardware', () => {
      // sim toggles too slow — second edge 600ms late, well past slack
      const sim: Trace = [
        { tNs: 0, kind: 'gpio', key: '13=1' },
        { tNs: 1_100_000_000, kind: 'gpio', key: '13=0' },
        { tNs: 1_000_000_000, kind: 'gpio', key: '13=1' },
      ];
      const r = calibrateLab(sim, hwTrace(blinkRef));
      expect(r.calibrated).toBe(false);
      expect(r.mismatches).toBeGreaterThan(0);
      expect(r.supportedGrade).toBe('B');
      expect(r.detail).toMatch(/DIVERGES/);
    });

    it('catches a missing event (sim never produced the third edge)', () => {
      const sim: Trace = blinkRef.slice(0, 2);
      const r = calibrateLab(sim, hwTrace(blinkRef));
      expect(r.calibrated).toBe(false);
      expect(r.mismatches).toBe(1);
    });
  });

  describe(`HIL applyCalibration (round ${round})`, () => {
    const entry = ledgerFor('blink_timing') as ConformanceLab;

    it('flips an uncalibrated ledger entry on a passing calibration', () => {
      const r = calibrateLab(blinkRef, hwTrace(blinkRef), { timeToleranceNs: 50_000 });
      const updated = applyCalibration(entry, r);
      expect(entry.calibrated).toBe(false); // original untouched (I7 default)
      expect(updated.calibrated).toBe(true);
      expect(updated.grade).toBe('A');
      expect(updated.note).toContain('calibrated vs arduino-uno');
    });

    it('leaves the entry untouched on a failing calibration (never over-claims)', () => {
      const bad: Trace = [{ tNs: 0, kind: 'gpio', key: '13=0' }];
      const r = calibrateLab(bad, hwTrace(blinkRef));
      expect(applyCalibration(entry, r)).toEqual(entry);
    });
  });
}
