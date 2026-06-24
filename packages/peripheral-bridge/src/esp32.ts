/**
 * ESP32-C3 peripheral conventions — REFERENCE-SPEC Stage 4. The C3 GPIO matrix is flat
 * (digital pin N = GPIO N, unlike AVR ports), so the bridge maps C3 GPIO/UART/I2C/SPI/
 * ADC/LEDC activity onto the same virtual-time BridgeEvents the Stage-3 kernel already
 * consumes. These conventions + validation are toolchain-independent; the emulator /
 * simulation-profile (Stage 4 gate) drives them once the RISC-V toolchain pack exists.
 */

import type { BridgeEvent, BridgeInput } from '@sparklab/shared';

/** GPIOs the C3 exposes for sketches; 11–17 are wired to the SPI flash (reserved). */
export const C3_USABLE_GPIOS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21] as const;

/** ADC1 channels: GPIO0–GPIO4 → channel 0–4. */
const ADC1: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 };

export const C3_DEFAULTS = {
  uart0: { tx: 21, rx: 20 },
  i2c: { sda: 8, scl: 9 },
  spi: { mosi: 6, miso: 5, sck: 4, ss: 7 },
  ledcChannels: 6,
} as const;

export function isUsableC3Gpio(gpio: number): boolean {
  return (C3_USABLE_GPIOS as readonly number[]).includes(gpio);
}

/** Map a C3 analog pin (GPIO) to its ADC1 channel, or null if not an ADC pin. */
export function c3AnalogChannel(gpio: number): number | null {
  return gpio in ADC1 ? ADC1[gpio]! : null;
}

/** Build a virtual-time gpio_write BridgeEvent for a C3 GPIO. */
export function c3GpioWrite(tNs: number, gpio: number, value: 0 | 1): BridgeEvent {
  if (!isUsableC3Gpio(gpio)) throw new Error(`GPIO${gpio} is not a usable ESP32-C3 pin`);
  return { t: tNs, type: 'gpio_write', pin: gpio, value };
}

/** Build a LEDC (PWM) config event for a C3 GPIO. */
export function c3LedcConfig(
  tNs: number,
  gpio: number,
  freqHz: number,
  dutyFraction: number,
): BridgeEvent {
  if (!isUsableC3Gpio(gpio)) throw new Error(`GPIO${gpio} is not a usable ESP32-C3 pin`);
  return { t: tNs, type: 'pwm_config', pin: gpio, freqHz, dutyFraction };
}

/** Inject an analog reading on a C3 ADC pin (12-bit on the C3 → raw 0..4095). */
export function c3AdcInput(
  tNs: number,
  gpio: number,
  raw: number,
): Extract<BridgeInput, { type: 'adc_value' }> {
  const channel = c3AnalogChannel(gpio);
  if (channel === null) throw new Error(`GPIO${gpio} is not an ESP32-C3 ADC pin`);
  return {
    t: tNs,
    type: 'adc_value',
    pin: channel,
    raw: Math.max(0, Math.min(4095, Math.round(raw))),
  };
}
