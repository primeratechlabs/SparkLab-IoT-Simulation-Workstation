import { describe, it, expect } from 'vitest';
import { StepperMotor, BiaxialStepper } from './stepper.js';
import { MockCircuitHost } from './mock-host.js';

// Pins A+,A-,B+,B- as 10,11,12,13. Drive one of the 8 half-step coil vectors.
const PINS = { aPlus: 10, aMinus: 11, bPlus: 12, bMinus: 13 };
const PHASES: Array<[number, number, number, number]> = [
  [1, 0, 0, 0], // +A
  [1, 0, 1, 0], // +A+B
  [0, 0, 1, 0], // +B
  [0, 1, 1, 0], // -A+B
  [0, 1, 0, 0], // -A
  [0, 1, 0, 1], // -A-B
  [0, 0, 0, 1], // -B
  [1, 0, 0, 1], // +A-B
];
function setPhase(host: MockCircuitHost, p: number): void {
  const [ap, am, bp, bm] = PHASES[p]!;
  host.mcuWrite(PINS.aPlus, ap ? 'high' : 'low');
  host.mcuWrite(PINS.aMinus, am ? 'high' : 'low');
  host.mcuWrite(PINS.bPlus, bp ? 'high' : 'low');
  host.mcuWrite(PINS.bMinus, bm ? 'high' : 'low');
}

describe('StepperMotor (bipolar 4-wire)', () => {
  it('steps forward as the drive sequence advances CW', () => {
    const m = new StepperMotor('s', PINS, 8);
    const host = new MockCircuitHost();
    m.attach(host);
    for (let p = 0; p < 8; p++) setPhase(host, p);
    setPhase(host, 0); // wrap 7 → 0 completes the 8th step
    expect(m.steps).toBe(8);
    expect(m.angleDeg).toBeCloseTo((8 * 360) / (8 * 2)); // 8 half-steps of an 8-step/rev motor
  });

  it('steps backward as the sequence retreats CCW', () => {
    const m = new StepperMotor('s', PINS, 8);
    const host = new MockCircuitHost();
    m.attach(host);
    setPhase(host, 0);
    for (let p = 7; p >= 0; p--) setPhase(host, p); // 0→7→6→…→0 = 8 CCW half-steps
    expect(m.steps).toBe(-8);
  });

  it('holds position once all coils are de-energised', () => {
    const m = new StepperMotor('s', PINS, 8);
    const host = new MockCircuitHost();
    m.attach(host);
    setPhase(host, 0);
    setPhase(host, 1);
    host.mcuWrite(PINS.aPlus, 'low'); // de-energise both coils → a=b=0 (off)
    host.mcuWrite(PINS.bPlus, 'low');
    const held = m.steps;
    host.mcuWrite(PINS.aMinus, 'low'); // further writes while off must NOT phantom-step
    host.mcuWrite(PINS.bMinus, 'low');
    expect(m.steps).toBe(held);
  });
});

describe('BiaxialStepper', () => {
  it('drives its two axes independently', () => {
    const m = new BiaxialStepper(
      'b',
      { aPlus: 2, aMinus: 3, bPlus: 4, bMinus: 5 },
      { aPlus: 6, aMinus: 7, bPlus: 8, bMinus: 9 },
      8,
    );
    const host = new MockCircuitHost();
    m.attach(host);
    // step axis 1 forward one half-step (+A → +A+B)
    host.mcuWrite(2, 'high');
    host.mcuWrite(4, 'low');
    host.mcuWrite(4, 'high');
    expect(m.axis1.steps).toBe(1);
    expect(m.axis2.steps).toBe(0); // axis 2 untouched
  });
});
