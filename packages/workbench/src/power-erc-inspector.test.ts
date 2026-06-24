import { describe, expect, it } from 'vitest';
import { PowerErcInspector } from './power-erc-inspector.js';

describe('PowerErcInspector', () => {
  it('classifies healthy, voltage-error and over-current rails', () => {
    const inspector = new PowerErcInspector();
    inspector.setRails([
      {
        id: '5v',
        label: '5V',
        voltage: 5.02,
        minVoltage: 4.75,
        maxVoltage: 5.25,
        currentMa: 120,
        maxCurrentMa: 500,
      },
      { id: '3v3', label: '3.3V', voltage: 4.1, minVoltage: 3.1, maxVoltage: 3.5 },
      {
        id: 'servo',
        label: 'Servo',
        voltage: 5,
        minVoltage: 4.8,
        maxVoltage: 6,
        currentMa: 900,
        maxCurrentMa: 500,
      },
    ]);

    expect(inspector.rails().map((rail) => rail.status)).toEqual(['ok', 'error', 'warning']);
    expect(inspector.summary()).toMatchObject({ railErrors: 1, railWarnings: 1 });
  });

  it('merges ERC severity into one actionable summary', () => {
    const inspector = new PowerErcInspector();
    inspector.setErcFindings([
      { rule: 'power-short', severity: 'error', message: 'VCC and GND are shorted', refs: ['VCC'] },
      {
        rule: 'floating-input',
        severity: 'warning',
        message: 'D5 is floating',
        refs: ['uno', 'n5'],
      },
    ]);

    expect(inspector.summary()).toEqual({
      status: 'error',
      errors: 1,
      warnings: 1,
      railErrors: 0,
      railWarnings: 0,
    });
    expect(inspector.findings('error')).toHaveLength(1);
    expect(inspector.findings('warning')).toHaveLength(1);
  });

  it('replaces duplicate rail ids and treats absent optional telemetry as unknown, not failure', () => {
    const inspector = new PowerErcInspector();
    inspector.setRail({ id: '5v', label: '5V', voltage: 5 });
    inspector.setRail({ id: '5v', label: 'USB 5V', voltage: 4.9 });

    expect(inspector.rails()).toEqual([
      expect.objectContaining({ id: '5v', label: 'USB 5V', status: 'unknown' }),
    ]);
    expect(inspector.summary().status).toBe('unknown');
  });
});
