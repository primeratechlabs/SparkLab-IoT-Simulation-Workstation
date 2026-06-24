import { describe, expect, it } from 'vitest';
import { PwmInspector, servoAngleFromPulse } from './pwm-inspector.js';

describe('PwmInspector', () => {
  it('derives period, pulse width, duty percent and servo angle from PWM config', () => {
    const inspector = new PwmInspector();
    inspector.ingest({ t: 10, type: 'pwm_config', pin: 9, freqHz: 50, dutyFraction: 0.075 });

    expect(inspector.channels()[0]).toMatchObject({
      pin: 9,
      frequencyHz: 50,
      periodUs: 20_000,
      highUs: 1500,
      dutyPercent: 7.5,
      servoAngleDeg: 90,
      valid: true,
    });
  });

  it('keeps the latest channel state while retaining bounded history', () => {
    const inspector = new PwmInspector({ maxHistoryPerPin: 2 });
    inspector.ingest({ t: 1, type: 'pwm_config', pin: 3, freqHz: 490, dutyFraction: 0.25 });
    inspector.ingest({ t: 2, type: 'pwm_config', pin: 3, freqHz: 490, dutyFraction: 0.5 });
    inspector.ingest({ t: 3, type: 'pwm_config', pin: 3, freqHz: 490, dutyFraction: 0.75 });

    expect(inspector.channel(3)?.dutyPercent).toBe(75);
    expect(inspector.history(3).map((entry) => entry.tNs)).toEqual([2, 3]);
  });

  it('reports invalid frequency without emitting non-finite geometry', () => {
    const inspector = new PwmInspector();
    inspector.ingest({ t: 1, type: 'pwm_config', pin: 5, freqHz: 0, dutyFraction: Number.NaN });

    const channel = inspector.channel(5)!;
    expect(channel.valid).toBe(false);
    expect(channel.periodUs).toBe(0);
    expect(channel.highUs).toBe(0);
    expect(channel.dutyPercent).toBe(0);
    expect(channel.warning).toMatch(/frequency/i);
  });

  it('marks a non-finite duty cycle invalid even when frequency is usable', () => {
    const inspector = new PwmInspector();
    inspector.ingest({ t: 1, type: 'pwm_config', pin: 5, freqHz: 490, dutyFraction: Number.NaN });

    expect(inspector.channel(5)).toMatchObject({
      valid: false,
      dutyPercent: 0,
      warning: expect.stringMatching(/duty/i),
    });
  });

  it('clamps duty cycle and servo pulse ranges safely', () => {
    const inspector = new PwmInspector();
    inspector.ingest({ t: 1, type: 'pwm_config', pin: 6, freqHz: 50, dutyFraction: 2 });

    expect(inspector.channel(6)?.dutyPercent).toBe(100);
    expect(servoAngleFromPulse(500)).toBe(0);
    expect(servoAngleFromPulse(1500)).toBe(90);
    expect(servoAngleFromPulse(2500)).toBe(180);
  });
});
