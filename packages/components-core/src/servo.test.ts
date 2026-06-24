import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { ServoSg90 } from './servo.js';

/**
 * Drive one 50Hz servo pulse on `pin`: raise the line, hold it HIGH for `widthUs`
 * (advancing virtual time so the servo captures a real width via host.now()), then
 * drop it. Advances the remaining ~20ms LOW idle so consecutive calls behave like the
 * Servo library's frame cadence. Returns with the pin LOW.
 */
function drivePulse(host: MockCircuitHost, pin: number, widthUs: number): void {
  host.mcuWrite(pin, 'high');
  host.advance(widthUs * 1000); // µs → ns
  host.mcuWrite(pin, 'low');
  const idleUs = 20_000 - widthUs; // 50Hz frame = 20ms period
  if (idleUs > 0) host.advance(idleUs * 1000);
}

describe('ServoSg90', () => {
  it('measures 1500µs → ~90° (centre) over one cycle', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    host.mcuWrite(9, 'high'); // rising edge at t0
    host.advance(1500_000); // 1500µs HIGH
    host.mcuWrite(9, 'low'); // falling edge → width = 1500µs

    expect(servo.angleDeg).toBeCloseTo(90, 5);
    expect(servo.pulses).toBe(1);
  });

  it('measures the three reference widths: 1000→0°, 1500→90°, 2000→180°', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    drivePulse(host, 9, 1500);
    expect(servo.angleDeg).toBeCloseTo(90, 5);

    drivePulse(host, 9, 1000);
    expect(servo.angleDeg).toBeCloseTo(0, 5);

    drivePulse(host, 9, 2000);
    expect(servo.angleDeg).toBeCloseTo(180, 5);

    expect(servo.pulses).toBe(3);
  });

  it('is linear in between (1250µs → 45°, 1750µs → 135°)', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    drivePulse(host, 9, 1250);
    expect(servo.angleDeg).toBeCloseTo(45, 5);

    drivePulse(host, 9, 1750);
    expect(servo.angleDeg).toBeCloseTo(135, 5);
  });

  it('clamps below 1000µs to 0° and above 2000µs to 180°', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    // 544µs is the Servo library's true minimum — should saturate at 0°, not go negative.
    drivePulse(host, 9, 544);
    expect(servo.angleDeg).toBe(0);

    // 2400µs is the library's maximum — should saturate at 180°, not overshoot.
    drivePulse(host, 9, 2400);
    expect(servo.angleDeg).toBe(180);
  });

  it('reports nothing before the first complete pulse', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    expect(servo.angleDeg).toBe(-1);
    expect(servo.pulses).toBe(0);

    // A rising edge with no matching fall yet is not a measurement.
    host.mcuWrite(9, 'high');
    host.advance(1500_000);
    expect(servo.angleDeg).toBe(-1);
    expect(servo.pulses).toBe(0);

    // The falling edge closes the pulse.
    host.mcuWrite(9, 'low');
    expect(servo.angleDeg).toBeCloseTo(90, 5);
    expect(servo.pulses).toBe(1);
  });

  it('ignores a falling edge that has no preceding rise (spurious low)', () => {
    const host = new MockCircuitHost();
    host.mcuWrite(9, 'high'); // pin starts HIGH before attach
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    // Re-writing HIGH is not an edge; a transition straight to LOW would normally
    // close a pulse, but only because attach seeded the rise time. Verify the seed.
    host.advance(1500_000);
    host.mcuWrite(9, 'low');
    expect(servo.pulses).toBe(1);
    expect(servo.angleDeg).toBeCloseTo(90, 5);

    // A second, unpaired LOW (already LOW) is a no-op — no phantom pulse.
    host.mcuWrite(9, 'low');
    expect(servo.pulses).toBe(1);
  });

  it('ignores repeated same-level writes (only true edges count)', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    host.mcuWrite(9, 'high');
    host.advance(500_000);
    host.mcuWrite(9, 'high'); // repeat HIGH — must not restart the rise timer
    host.advance(1000_000);
    host.mcuWrite(9, 'low'); // total width 1500µs → 90°

    expect(servo.pulses).toBe(1);
    expect(servo.angleDeg).toBeCloseTo(90, 5);
  });

  it('tracks a sweep across many frames, holding the last measured angle', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);

    // Sweep 0° → 180° in 10° steps (1000µs + 5.555µs/deg).
    let lastAngle = 0;
    let count = 0;
    for (let deg = 0; deg <= 180; deg += 10) {
      const widthUs = 1000 + (deg / 180) * 1000;
      drivePulse(host, 9, widthUs);
      lastAngle = deg;
      count++;
      expect(servo.angleDeg).toBeCloseTo(deg, 4);
    }
    expect(servo.pulses).toBe(count);
    expect(servo.angleDeg).toBeCloseTo(lastAngle, 4);

    // No new pulse: the angle is held, not reset.
    host.advance(20_000_000);
    expect(servo.angleDeg).toBeCloseTo(lastAngle, 4);
    expect(servo.pulses).toBe(count);
  });

  it('never drives the signal pin or touches the ADC/I2C surface (pure sink)', () => {
    const host = new MockCircuitHost();
    const servo = new ServoSg90('servo1', 9);
    servo.attach(host);
    drivePulse(host, 9, 1500);
    expect(host.driven.size).toBe(0);
    expect(host.adc.size).toBe(0);
    expect(host.i2c.size).toBe(0);
  });
});
