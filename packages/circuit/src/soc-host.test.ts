/**
 * SocHost — the ESP32 device-runtime host wiring, proven with the REAL C3 SoC peripherals + the REAL
 * components-core device models (no firmware needed; we drive the peripherals directly as the firmware
 * would). This is the SoC half of the root-cause fix: a drawn device, attached to the running emulator,
 * reflects firmware output (LED) / receives stimulus (pot) / sits on the I²C bus (LCD) / decodes PWM
 * duty (brightness) — the seam that left CMB-01..04 inert. CI-runnable (no toolchain).
 */
import { describe, it, expect } from 'vitest';
import {
  C3Gpio,
  C3Adc,
  C3I2c,
  C3Ledc,
  C3_GPIO_BASE,
  C3_I2C0_BASE,
  C3_LEDC_BASE,
} from '@sparklab/emulators';
import { Led, LcdI2c, Potentiometer, HcSr04 } from '@sparklab/components-core';
import { SocHost, type SocBackend } from './soc-host.js';

const GPIO_OUT = C3_GPIO_BASE + 0x04;
const GPIO_EN = C3_GPIO_BASE + 0x20;

function makeBackend(): {
  backend: SocBackend;
  gpio: C3Gpio;
  adc: C3Adc;
  i2c: C3I2c;
  ledc: C3Ledc;
  advance(ns: number): void;
} {
  const gpio = new C3Gpio();
  const adc = new C3Adc();
  const i2c = new C3I2c();
  const ledc = new C3Ledc();
  let t = 0;
  const backend: SocBackend = {
    gpio,
    adc,
    i2c,
    ledc,
    get virtualTimeNs() {
      return t;
    },
  };
  return { backend, gpio, adc, i2c, ledc, advance: (ns) => (t += ns) };
}

describe('SocHost — device-runtime host over ESP32 SoC peripherals', () => {
  it('an LED reflects the firmware GPIO output it is wired to (CMB reflection)', () => {
    const { backend, gpio } = makeBackend();
    const host = new SocHost(backend);
    const led = new Led('led', 2);
    host.add(led);
    expect(led.on).toBe(false);

    gpio.write32(GPIO_OUT, 1 << 2); // firmware drives GPIO2 HIGH
    expect(led.on).toBe(true);
    expect(led.toggles).toBe(1);
    gpio.write32(GPIO_OUT, 0); // LOW
    expect(led.on).toBe(false);
    expect(led.toggles).toBe(2);
  });

  it('a potentiometer injects an ADC voltage the firmware would read (sensor stimulus)', () => {
    const { backend, adc } = makeBackend();
    const host = new SocHost(backend);
    const pot = new Potentiometer('pot', 3, { vcc: 3.3, ohms: 10_000 });
    host.add(pot);
    pot.setPosition(1); // full scale → ~3.3V → ~4095 raw
    expect(adc.read32(0x60020000 + (3 << 2))).toBeGreaterThan(4000);
    pot.setPosition(0); // → 0V → 0
    expect(adc.read32(0x60020000 + (3 << 2))).toBe(0);
  });

  it('an I²C LCD is attached to the bus and receives the firmware byte stream (CMB-02)', () => {
    const { backend, i2c } = makeBackend();
    const host = new SocHost(backend);
    const lcd = new LcdI2c('lcd', 0x27);
    host.add(lcd);
    // firmware Wire transaction: begin(0x27) → write a byte → stop. The byte reaches the attached LCD.
    i2c.write32(C3_I2C0_BASE + 0x04, 0x27);
    i2c.write32(C3_I2C0_BASE + 0x00, 0x55);
    i2c.write32(C3_I2C0_BASE + 0x08, 1);
    expect(lcd.bytes).toBeGreaterThan(0); // the LCD is on the bus and saw the write
  });

  it('PWM duty (ledcWrite) is decoded to a 0..1 brightness fraction, not binary (CMB-04)', () => {
    const { backend, ledc } = makeBackend();
    const host = new SocHost(backend, 255); // 8-bit resolution
    ledc.write32(C3_LEDC_BASE + (2 << 3), 128); // channel 2 (pin 2), duty 128/255
    expect(host.duty.get(2)).toBeCloseTo(0.502, 2);
    ledc.write32(C3_LEDC_BASE + (2 << 3), 255);
    expect(host.duty.get(2)).toBe(1);
  });

  it('pump() fires scheduled events at their virtual time (HC-SR04 echo timing)', () => {
    const { backend, gpio, advance } = makeBackend();
    const host = new SocHost(backend);
    const sonar = new HcSr04('sonar', 8, 9);
    sonar.distanceCm = 25;
    host.add(sonar);
    gpio.write32(GPIO_EN, (1 << 8) | (1 << 9)); // trig+echo output-enabled (so pinLevel reads OUT)
    gpio.write32(GPIO_OUT, 1 << 8); // rising edge on TRIG → schedules the echo
    // advance virtual time and pump; the scheduled echo-high + echo-low fire in order
    for (let i = 0; i < 2000; i++) {
      advance(1000); // 1µs per pump
      host.pump();
    }
    expect(sonar.pulses).toBeGreaterThan(0); // the sensor produced an echo pulse
  });
});
