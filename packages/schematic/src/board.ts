/**
 * Board catalog — the MCU header definitions the document wires components to. A board pin carries a
 * NAME, an electrical role (`type`, for display/colour), provisional canvas coords, and — the
 * authoritative bit — its CAPABILITIES: `digitalPin` (the number digitalWrite/pinMode expect) and/or
 * `adcChannel` (what analogRead expects). Many MCU pins are dual (a GPIO that is also an ADC input),
 * so capabilities are independent flags, not a single type. The resolver (netgraph.ts) matches on
 * these, board-agnostically.
 *
 * Coordinates are PROVISIONAL — the visual board SVG (the user's design, or mirrored wokwi-elements
 * pinInfo) owns the final layout. Pin names + numbers are authoritative.
 *
 * Boards: Arduino Uno (Stage 2, AVR — runnable today via @sparklab/circuit), ESP32-C3-DevKitM
 * (Stage 4, RISC-V) and ESP32 DevKit (Stage 5, Xtensa). The ESP32 run path needs its own harness
 * (rv32/Xtensa interpreter + sim profile); the editor MODEL targets all three now.
 */
import type { PinType } from './types.js';

export interface BoardPin {
  name: string;
  type: PinType;
  /** Provisional canvas offset from the board origin; the board SVG refines these. */
  x: number;
  y: number;
  /** Number digitalWrite/pinMode expect (Arduino pin on Uno, GPIO on ESP32); absent for power/analog-only. */
  digitalPin?: number;
  /** ADC channel analogRead expects, if this pin is ADC-capable; absent otherwise. */
  adcChannel?: number;
  /** The hardware I2C line this pin carries (for I2C-bus topology checks), if any. */
  i2c?: 'SDA' | 'SCL';
}

export interface BoardCatalogEntry {
  id: string;
  displayName: string;
  mcu: string;
  architecture: 'avr' | 'riscv32' | 'xtensa';
  size: { w: number; h: number };
  pins: BoardPin[];
  /** Pin name carrying the VCC rail (for netlist vccNet derivation). */
  vccPin: string;
  /** Pin name carrying the GND rail (for netlist gndNet derivation). */
  gndPin: string;
  /** Digital pin number of the on-board "L" LED (board-aware activity counter — CMB-11). */
  onboardLedPin: number;
}

// ── Arduino Uno (ATmega328P) ─────────────────────────────────────────────────
function unoPins(): BoardPin[] {
  const pins: BoardPin[] = [];
  for (let n = 0; n <= 13; n++)
    pins.push({ name: `D${n}`, type: 'digital', digitalPin: n, x: 24 + n * 18, y: 0 });
  // A0..A5 are ADC channels 0..5 (left as analog-only: avr8js digital ports cover D0..D13).
  // A4/A5 also carry the hardware I2C bus (SDA/SCL).
  for (let c = 0; c <= 5; c++) {
    pins.push({
      name: `A${c}`,
      type: 'analog',
      adcChannel: c,
      x: 120 + c * 18,
      y: 200,
      ...(c === 4 ? { i2c: 'SDA' as const } : c === 5 ? { i2c: 'SCL' as const } : {}),
    });
  }
  pins.push({ name: '3V3', type: 'power', x: 42, y: 200 });
  pins.push({ name: '5V', type: 'power', x: 60, y: 200 });
  pins.push({ name: 'GND', type: 'ground', x: 78, y: 200 });
  pins.push({ name: 'VIN', type: 'power', x: 96, y: 200 });
  return pins;
}

// ── ESP32-C3-DevKitM-1 (RISC-V) — GPIO0..10,18..21; ADC1 on GPIO0..4 ─────────
function esp32C3Pins(): BoardPin[] {
  const gpios = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21];
  const adc: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 }; // GPIOn → ADC1 channel n
  const i2cLine: Record<number, 'SDA' | 'SCL'> = { 8: 'SDA', 9: 'SCL' }; // C3 default I2C
  const pins: BoardPin[] = gpios.map((g, i) => ({
    name: `GPIO${g}`,
    type: 'digital',
    digitalPin: g,
    ...(adc[g] !== undefined ? { adcChannel: adc[g] } : {}),
    ...(i2cLine[g] ? { i2c: i2cLine[g] } : {}),
    x: i < 8 ? 0 : 120,
    y: (i % 8) * 18,
  }));
  pins.push({ name: '3V3', type: 'power', x: 0, y: 160 });
  pins.push({ name: '5V', type: 'power', x: 60, y: 160 });
  pins.push({ name: 'GND', type: 'ground', x: 120, y: 160 });
  return pins;
}

// ── ESP32 DevKit (classic, Xtensa LX6) — pin set mirrors wokwi esp32-devkit-v1 ─
function esp32ClassicPins(): BoardPin[] {
  // [name, gpio, adcChannel?] — digital-capable pins
  const digital: Array<[string, number, number?]> = [
    ['D2', 2],
    ['D4', 4],
    ['D5', 5],
    ['D12', 12],
    ['D13', 13],
    ['D14', 14],
    ['D15', 15],
    ['D18', 18],
    ['D19', 19],
    ['D21', 21],
    ['D22', 22],
    ['D23', 23],
    ['D25', 25],
    ['D26', 26],
    ['D27', 27],
    ['D32', 32, 4],
    ['D33', 33, 5],
    ['TX0', 1],
    ['RX0', 3],
    ['RX2', 16],
    ['TX2', 17],
  ];
  // input-only ADC1 pins (cannot digitalWrite): name, gpio, adcChannel
  const analogOnly: Array<[string, number, number]> = [
    ['D34', 34, 6],
    ['D35', 35, 7],
    ['VP', 36, 0],
    ['VN', 39, 3],
  ];
  const pins: BoardPin[] = [];
  const i2cLine: Record<number, 'SDA' | 'SCL'> = { 21: 'SDA', 22: 'SCL' }; // ESP32 classic default I2C
  digital.forEach(([name, gpio, adcChannel], i) => {
    pins.push({
      name,
      type: 'digital',
      digitalPin: gpio,
      ...(adcChannel !== undefined ? { adcChannel } : {}),
      ...(i2cLine[gpio] ? { i2c: i2cLine[gpio] } : {}),
      x: i < 11 ? 0 : 120,
      y: (i % 11) * 16,
    });
  });
  analogOnly.forEach(([name, , adcChannel], i) => {
    pins.push({ name, type: 'analog', adcChannel, x: 0, y: 180 + i * 16 });
  });
  pins.push({ name: '3V3', type: 'power', x: 120, y: 180 });
  pins.push({ name: '5V', type: 'power', x: 120, y: 196 });
  pins.push({ name: 'GND', type: 'ground', x: 120, y: 212 });
  return pins;
}

export const BOARD_CATALOG: Record<string, BoardCatalogEntry> = {
  'arduino-uno': {
    id: 'arduino-uno',
    displayName: 'Arduino Uno',
    mcu: 'atmega328p',
    architecture: 'avr',
    size: { w: 280, h: 200 },
    pins: unoPins(),
    vccPin: '5V',
    gndPin: 'GND',
    onboardLedPin: 13, // the "L" LED hardwired to D13
  },
  'esp32-c3-devkitm': {
    id: 'esp32-c3-devkitm',
    displayName: 'ESP32-C3 DevKitM',
    mcu: 'esp32c3',
    architecture: 'riscv32',
    size: { w: 200, h: 180 },
    pins: esp32C3Pins(),
    vccPin: '3V3',
    gndPin: 'GND',
    onboardLedPin: 8, // ESP32-C3-DevKitM on-board RGB LED on GPIO8
  },
  'esp32-devkit': {
    id: 'esp32-devkit',
    displayName: 'ESP32 DevKit',
    mcu: 'esp32',
    architecture: 'xtensa',
    size: { w: 200, h: 240 },
    pins: esp32ClassicPins(),
    vccPin: '3V3',
    gndPin: 'GND',
    onboardLedPin: 2, // ESP32 DevKit on-board LED on GPIO2
  },
};

export const BOARD_TYPES: string[] = Object.keys(BOARD_CATALOG);

export function boardEntry(id: string): BoardCatalogEntry | undefined {
  return BOARD_CATALOG[id];
}

/** Look up a board pin by name. */
export function boardPin(boardId: string, pinName: string): BoardPin | undefined {
  return BOARD_CATALOG[boardId]?.pins.find((p) => p.name === pinName);
}

/**
 * Board id → wokwi-elements board tag (vendored visual layer). ESP32-C3 has no wokwi element, so it
 * is absent and rendered with our own SVG. Pin coords/aliases come from the element's runtime
 * `pinInfo` at UI-build time.
 */
export const WOKWI_BOARD_ELEMENT: Record<string, string> = {
  'arduino-uno': 'wokwi-arduino-uno',
  'esp32-devkit': 'wokwi-esp32-devkit-v1',
};

export function wokwiBoardTagFor(id: string): string | undefined {
  return WOKWI_BOARD_ELEMENT[id];
}
