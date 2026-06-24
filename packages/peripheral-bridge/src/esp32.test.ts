import { describe, it, expect } from 'vitest';
import {
  isUsableC3Gpio,
  c3AnalogChannel,
  c3GpioWrite,
  c3LedcConfig,
  c3AdcInput,
  C3_DEFAULTS,
} from './esp32.js';

describe('ESP32-C3 conventions', () => {
  it('knows which GPIOs are usable (flash pins 11–17 reserved)', () => {
    expect(isUsableC3Gpio(2)).toBe(true);
    expect(isUsableC3Gpio(21)).toBe(true);
    expect(isUsableC3Gpio(12)).toBe(false); // SPI flash
    expect(isUsableC3Gpio(99)).toBe(false);
  });

  it('maps ADC1 pins GPIO0–4 to channels 0–4', () => {
    expect(c3AnalogChannel(0)).toBe(0);
    expect(c3AnalogChannel(4)).toBe(4);
    expect(c3AnalogChannel(8)).toBeNull(); // not an ADC pin
  });

  it('emits gpio_write / pwm BridgeEvents for usable pins and rejects reserved ones', () => {
    expect(c3GpioWrite(100, 2, 1)).toEqual({ t: 100, type: 'gpio_write', pin: 2, value: 1 });
    expect(c3LedcConfig(200, 5, 5000, 0.25)).toEqual({
      t: 200,
      type: 'pwm_config',
      pin: 5,
      freqHz: 5000,
      dutyFraction: 0.25,
    });
    expect(() => c3GpioWrite(0, 13, 1)).toThrow(/not a usable/);
  });

  it('injects 12-bit ADC readings on ADC pins (clamped 0..4095)', () => {
    expect(c3AdcInput(0, 3, 2048)).toEqual({ t: 0, type: 'adc_value', pin: 3, raw: 2048 });
    expect(c3AdcInput(0, 3, 99999).raw).toBe(4095); // clamped to 12-bit
    expect(() => c3AdcInput(0, 8, 0)).toThrow(/not an ESP32-C3 ADC/);
  });

  it('exposes the C3 default peripheral pins', () => {
    expect(C3_DEFAULTS.uart0).toEqual({ tx: 21, rx: 20 });
    expect(C3_DEFAULTS.i2c).toEqual({ sda: 8, scl: 9 });
  });
});
