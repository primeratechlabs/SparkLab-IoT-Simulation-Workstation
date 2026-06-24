import { describe, it, expect } from 'vitest';
import {
  FIDELITY_LEDGER,
  STANDARD_LABS,
  ledgerFor,
  allUncalibrated,
  ledgerCoversStandardLabs,
  isValidGrade,
} from './fidelity-ledger.js';

describe('fidelity ledger (Stage 7, I7)', () => {
  it('covers every standard lab — no silent gaps', () => {
    expect(ledgerCoversStandardLabs()).toBe(true);
    for (const lab of STANDARD_LABS) expect(ledgerFor(lab)).toBeDefined();
  });

  it('marks ALL labs uncalibrated until a hardware rig exists (I7 honesty)', () => {
    expect(allUncalibrated()).toBe(true);
    for (const e of FIDELITY_LEDGER) expect(e.calibrated).toBe(false);
  });

  it('every entry has a valid grade and a real note', () => {
    for (const e of FIDELITY_LEDGER) {
      expect(isValidGrade(e.grade), `${e.lab} grade ${e.grade}`).toBe(true);
      expect(e.note.length).toBeGreaterThan(15);
    }
  });

  it('never over-claims: no lab is grade A while uncalibrated', () => {
    for (const e of FIDELITY_LEDGER) {
      if (!e.calibrated) expect(e.grade).not.toBe('A');
    }
  });
});
