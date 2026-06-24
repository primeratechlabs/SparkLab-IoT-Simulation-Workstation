/**
 * Stage 7 conformance — the standard lab set as golden traces (gate #1 + #5). Unlike the
 * firmware-backed blink_timing/uart_echo (toolchain-gated, conformance.test.ts), these run the
 * real sub-systems directly (sim-kernel I2C engine, emulator LEDC, network-shim WiFi/MQTT), so
 * they're deterministic and always run in CI. References are SIMULATOR-GENERATED and UNCALIBRATED
 * (invariant I7 — the fidelity ledger marks them so); the test asserts the comparator matches and
 * the run is reproducible, guarding against regressions, not against real silicon.
 */
import { describe, it, expect } from 'vitest';
import { I2cBus, type I2cDevice } from '@sparklab/sim-kernel';
import { C3Ledc, C3_LEDC_BASE } from '@sparklab/emulators';
import { WiFiSim, FakeMqttBroker, WL_CONNECTED } from '@sparklab/network-shim';
import { compareTraces, ledgerFor, type Trace } from '@sparklab/conformance';

const ackDevice = (): I2cDevice => ({
  startWrite: () => true,
  startRead: () => true,
  write: () => true,
  read: () => 0,
  stop: () => {},
});

function i2cScan(bus: I2cBus): Trace {
  const t: Trace = [];
  let tNs = 0;
  for (let a = 0x08; a <= 0x77; a++) {
    if (bus.connect(a, false)) t.push({ tNs, kind: 'i2c', key: `found:0x${a.toString(16)}` });
    bus.stop();
    tNs += 100_000; // 100 µs per probe (virtual time)
  }
  return t;
}

describe('Stage 7 conformance — standard lab set (uncalibrated golden traces, I7)', () => {
  it('i2c_scan: finds exactly the attached devices, reproducibly', () => {
    const build = (): I2cBus => {
      const b = new I2cBus();
      b.setPullups(true);
      b.addDevice(0x27, ackDevice()); // PCF8574 LCD
      b.addDevice(0x68, ackDevice()); // DS3231 RTC
      return b;
    };
    const reference: Trace = [
      { tNs: (0x27 - 0x08) * 100_000, kind: 'i2c', key: 'found:0x27' },
      { tNs: (0x68 - 0x08) * 100_000, kind: 'i2c', key: 'found:0x68' },
    ];
    const actual = i2cScan(build());
    expect(compareTraces(reference, actual).ok).toBe(true);
    expect(i2cScan(build())).toEqual(actual); // deterministic
    expect(ledgerFor('i2c_scan')?.calibrated).toBe(false); // honestly uncalibrated
  });

  it('pwm_sweep: LEDC duty follows the written sweep, reproducibly', () => {
    const sweep = (): Trace => {
      const ledc = new C3Ledc();
      const t: Trace = [];
      let tNs = 0;
      ledc.onDuty = (ch, duty) => t.push({ tNs, kind: 'pwm', key: `ch${ch}:${duty}` });
      for (const d of [0, 64, 128, 192, 255]) {
        ledc.write32(C3_LEDC_BASE, d); // channel 0 duty
        tNs += 1_000_000;
      }
      return t;
    };
    const reference: Trace = [0, 64, 128, 192, 255].map((d, i) => ({
      tNs: i * 1_000_000,
      kind: 'pwm',
      key: `ch0:${d}`,
    }));
    const actual = sweep();
    expect(compareTraces(reference, actual).ok).toBe(true);
    expect(sweep()).toEqual(actual);
    expect(ledgerFor('pwm_sweep')?.calibrated).toBe(false);
  });

  it('wifi_mqtt: connect → publish telemetry → receive command, reproducibly', () => {
    const run = (): Trace => {
      const t: Trace = [];
      let tNs = 0;
      const wifi = new WiFiSim(2);
      wifi.begin('sparklab');
      wifi.poll();
      wifi.poll();
      if (wifi.status() === WL_CONNECTED) t.push({ tNs, kind: 'wifi', key: 'connected' });
      tNs += 1_000_000;
      const broker = new FakeMqttBroker();
      broker.subscribe('dev/cmd', (m) => t.push({ tNs, kind: 'mqtt', key: `rx:${m.payload}` }));
      broker.publish('dev/telemetry', '2750');
      t.push({ tNs, kind: 'mqtt', key: 'pub:2750' });
      tNs += 1_000_000;
      broker.inject('dev/cmd', '1'); // cloud → device command fires the subscription
      return t;
    };
    const reference: Trace = [
      { tNs: 0, kind: 'wifi', key: 'connected' },
      { tNs: 1_000_000, kind: 'mqtt', key: 'pub:2750' },
      { tNs: 2_000_000, kind: 'mqtt', key: 'rx:1' },
    ];
    const actual = run();
    expect(compareTraces(reference, actual).ok).toBe(true);
    expect(run()).toEqual(actual);
    expect(ledgerFor('wifi_mqtt')?.calibrated).toBe(false);
  });

  it('the comparator actually catches a divergence (guard against a vacuous pass)', () => {
    const ref: Trace = [{ tNs: 0, kind: 'i2c', key: 'found:0x27' }];
    const wrong: Trace = [{ tNs: 0, kind: 'i2c', key: 'found:0x3c' }];
    expect(compareTraces(ref, wrong).ok).toBe(false);
  });
});
