/**
 * Component catalog — the declarative registry the palette renders from and the document→sim
 * bridge instantiates from. It fills the gap the codebase had: components-core ships behaviour
 * classes but no machine-readable metadata. Each entry declares pins (names + electrical type +
 * provisional canvas offsets), user-editable properties, the netlist kind, and a `build()` factory
 * that turns a placed component into a runnable SimComponent given the MCU pins it resolves to.
 *
 * NOTE on coordinates: pin `x/y` and `size` are PROVISIONAL placeholders so the geometry layer
 * works today. The visual design owns the final footprint; only the logical data (pin NAMES,
 * TYPES, netlist KIND, build factory) is authoritative here and design-independent.
 */
import type { SimComponent } from '@sparklab/components-core';
import {
  Led,
  RgbLed,
  PushButton,
  Potentiometer,
  Ldr,
  Ntc,
  Buzzer,
  Relay,
  ServoSg90,
  Dht22,
  HcSr04,
  LcdI2c,
  Ssd1306,
  Ds1307,
  Mpu6050,
  Ws2812,
  DigitalSensor,
  AnalogSensor,
  SevenSegment,
  LedBarGraph,
  DipSwitch,
  Joystick,
  RotaryEncoder,
  StepperMotor,
  BiaxialStepper,
  MembraneKeypad,
  KEYPAD_4X4,
  Hx711,
  RotaryDialer,
  IrReceiver,
  IrRemote,
  Ili9341,
  MicroSdCard,
} from '@sparklab/components-core';
import type { ComponentKind } from '@sparklab/sim-kernel';
import type { PinType, PropValue } from './types.js';
import { coerceNum, coerceBool, coerceI2cAddress } from './coerce.js';
import { breadboardGroups } from './breadboard.js';

export interface CatalogPin {
  name: string;
  type: PinType;
  /** Provisional offset from the component origin (unrotated); the design refines these. */
  x: number;
  y: number;
}

export type PropControl = 'text' | 'number' | 'boolean' | 'select';

export interface PropSpec {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  default: PropValue;
  control: PropControl;
  /** For control:'select'. */
  options?: PropValue[];
  min?: number;
  max?: number;
  step?: number;
  description?: string;
}

/** What `build()` is given to instantiate a runnable component from a placed one. */
export interface BuildContext {
  id: string;
  props: Record<string, PropValue>;
  /** MCU digital pin number wired (≤1 series-resistor hop) to the component's named pin. */
  digital(pin: string): number | undefined;
  /** MCU ADC channel wired to the component's named pin. */
  analog(pin: string): number | undefined;
}

export type ComponentCategory = 'output' | 'input' | 'sensor' | 'display' | 'passive' | 'actuator';

/**
 * How the user stimulates a part live while running (drives which inspector control the canvas shows):
 *   'button'        — momentary digital, operated via its own wokwi element (press); seeds released on run.
 *   'pot'           — analog knob, operated via its own wokwi element (turn) emitting a raw ADC value.
 *   'analog-sensor' — external analog stimulus SLIDER (the part carries no reading prop); re-seeded on run.
 * A sensor that instead carries a configurable reading prop (gas/flame `level`) has NO interaction — it is
 * applied live through the device-runtime `applyProp`, so it is never re-seeded to a default on run.
 */
export type InteractionKind = 'button' | 'pot' | 'analog-sensor';

export interface ComponentCatalogEntry {
  type: string;
  displayName: string;
  category: ComponentCategory;
  description: string;
  tags: string[];
  /** How this part appears in the simulator netlist (for ERC + budgets). */
  kind: ComponentKind;
  pins: CatalogPin[];
  properties: PropSpec[];
  size: { w: number; h: number };
  /** Instantiate a runnable SimComponent, or null for passive/netlist-only parts (resistor). */
  build(ctx: BuildContext): SimComponent | null;
  /** For i2c-device kinds: the 7-bit address derived from props (used by ERC conflict checks). */
  i2cAddress?(props: Record<string, PropValue>): number;
}

// Prop coercion lives in coerce.ts (single source of truth); these are local aliases for brevity.
const num = coerceNum;
const bool = coerceBool;

/** The LED colour palette — the SINGLE source for the catalog `color` prop options, the inspector
 *  swatches, and the cycle-colour command (previously THREE divergent lists). Every value is one the
 *  vendored wokwi-led renders (its built-in lightColors map). Add a colour here and it appears everywhere. */
export const LED_COLORS = ['red', 'green', 'blue', 'yellow', 'orange', 'white'] as const;
export type LedColor = (typeof LED_COLORS)[number];

/** Default 7-bit I²C addresses (the bus identity a sketch's `LiquidCrystal_I2C`/SSD1306 lib targets). */
const LCD_I2C_ADDR = 0x27;
const SSD1306_I2C_ADDR = 0x3c;

export const COMPONENT_CATALOG = {
  led: {
    type: 'led',
    displayName: 'LED',
    category: 'output',
    description:
      'Single-colour LED. Lights when its controlling MCU pin is HIGH. Needs a series resistor.',
    tags: ['led', 'light', 'output', 'gpio'],
    kind: 'led',
    pins: [
      { name: 'anode', type: 'digital', x: 8, y: 0 },
      { name: 'cathode', type: 'digital', x: 8, y: 32 },
    ],
    properties: [
      {
        name: 'color',
        label: 'Colour',
        type: 'string',
        default: 'red',
        control: 'select',
        options: [...LED_COLORS],
      },
    ],
    size: { w: 24, h: 36 },
    build: (c) => {
      const pin = c.digital('anode') ?? c.digital('cathode');
      return pin === undefined ? null : new Led(c.id, pin);
    },
  },

  'rgb-led': {
    type: 'rgb-led',
    displayName: 'RGB LED',
    category: 'output',
    description: 'Three-channel RGB LED driven by three GPIO pins.',
    tags: ['rgb', 'led', 'colour', 'output'],
    kind: 'rgb-led',
    pins: [
      { name: 'r', type: 'digital', x: 0, y: 0 },
      { name: 'g', type: 'digital', x: 8, y: 0 },
      { name: 'b', type: 'digital', x: 16, y: 0 },
      { name: 'common', type: 'power', x: 8, y: 32 },
    ],
    properties: [],
    size: { w: 28, h: 36 },
    build: (c) => {
      const r = c.digital('r');
      const g = c.digital('g');
      const b = c.digital('b');
      return r === undefined || g === undefined || b === undefined
        ? null
        : new RgbLed(c.id, r, g, b);
    },
  },

  resistor: {
    type: 'resistor',
    displayName: 'Resistor',
    category: 'passive',
    description:
      'Passive resistor. Part of the net topology (lets current/ERC reason about it); not actively simulated.',
    tags: ['resistor', 'passive', 'ohms'],
    kind: 'resistor',
    pins: [
      { name: 'a', type: 'digital', x: 0, y: 8 },
      { name: 'b', type: 'digital', x: 40, y: 8 },
    ],
    properties: [
      {
        name: 'ohms',
        label: 'Resistance (Ω)',
        type: 'number',
        default: 220,
        control: 'number',
        min: 0,
        step: 1,
      },
    ],
    size: { w: 48, h: 16 },
    build: () => null, // passive: contributes to the netlist only
  },

  button: {
    type: 'button',
    displayName: 'Push Button',
    category: 'input',
    description: 'Momentary push button. Pulls its MCU pin LOW when pressed (use INPUT_PULLUP).',
    tags: ['button', 'switch', 'input', 'gpio'],
    kind: 'button',
    pins: [
      { name: 'a', type: 'digital', x: 0, y: 8 },
      { name: 'b', type: 'ground', x: 24, y: 8 },
    ],
    properties: [],
    size: { w: 28, h: 24 },
    build: (c) => {
      const pin = c.digital('a') ?? c.digital('b');
      return pin === undefined ? null : new PushButton(c.id, pin);
    },
  },

  potentiometer: {
    type: 'potentiometer',
    displayName: 'Potentiometer',
    category: 'input',
    description: 'Rotary potentiometer as a voltage divider into an ADC channel.',
    tags: ['potentiometer', 'pot', 'analog', 'adc', 'input'],
    kind: 'potentiometer',
    pins: [
      { name: 'vcc', type: 'power', x: 0, y: 0 },
      { name: 'wiper', type: 'analog', x: 16, y: 0 },
      { name: 'gnd', type: 'ground', x: 32, y: 0 },
    ],
    properties: [
      {
        name: 'ohms',
        label: 'Resistance (Ω)',
        type: 'number',
        default: 10000,
        control: 'number',
        min: 0,
      },
    ],
    size: { w: 36, h: 28 },
    build: (c) => {
      const ch = c.analog('wiper');
      return ch === undefined
        ? null
        : new Potentiometer(c.id, ch, { ohms: num(c.props, 'ohms', 10000) });
    },
  },

  ldr: {
    type: 'ldr',
    displayName: 'LDR (photoresistor)',
    category: 'sensor',
    description: 'Light-dependent resistor in a voltage divider feeding an ADC channel.',
    tags: ['ldr', 'light', 'photoresistor', 'analog', 'sensor'],
    kind: 'ldr',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 16, y: 0 },
      { name: 'gnd', type: 'ground', x: 32, y: 0 },
    ],
    properties: [
      {
        name: 'rFixedOhms',
        label: 'Fixed R (Ω)',
        type: 'number',
        default: 10000,
        control: 'number',
        min: 0,
      },
    ],
    size: { w: 36, h: 24 },
    build: (c) => {
      const ch = c.analog('sig');
      return ch === undefined
        ? null
        : new Ldr(c.id, ch, { rFixedOhms: num(c.props, 'rFixedOhms', 10000) });
    },
  },

  ntc: {
    type: 'ntc',
    displayName: 'NTC thermistor',
    category: 'sensor',
    description: 'Negative-temperature-coefficient thermistor in a divider feeding an ADC channel.',
    tags: ['ntc', 'thermistor', 'temperature', 'analog', 'sensor'],
    kind: 'ntc',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 16, y: 0 },
      { name: 'gnd', type: 'ground', x: 32, y: 0 },
    ],
    properties: [
      { name: 'beta', label: 'Beta', type: 'number', default: 3950, control: 'number' },
      { name: 'r0', label: 'R0 (Ω @25°C)', type: 'number', default: 10000, control: 'number' },
    ],
    size: { w: 36, h: 24 },
    build: (c) => {
      const ch = c.analog('sig');
      return ch === undefined
        ? null
        : new Ntc(c.id, ch, { beta: num(c.props, 'beta', 3950), r0: num(c.props, 'r0', 10000) });
    },
  },

  buzzer: {
    type: 'buzzer',
    displayName: 'Buzzer',
    category: 'output',
    description: 'Piezo buzzer driven by a square wave on a GPIO pin.',
    tags: ['buzzer', 'piezo', 'sound', 'output'],
    kind: 'buzzer',
    pins: [
      { name: 'pos', type: 'digital', x: 8, y: 0 },
      { name: 'neg', type: 'ground', x: 8, y: 24 },
    ],
    properties: [],
    size: { w: 28, h: 28 },
    build: (c) => {
      const pin = c.digital('pos') ?? c.digital('neg');
      return pin === undefined ? null : new Buzzer(c.id, pin);
    },
  },

  relay: {
    type: 'relay',
    displayName: 'Relay',
    category: 'actuator',
    description:
      'Electromechanical relay; its coil is switched by a GPIO control pin (control + return).',
    tags: ['relay', 'switch', 'actuator', 'output'],
    kind: 'relay',
    // A bare relay coil is two terminals: the control side (driven from a GPIO) + the return to GND.
    // (Matches the wokwi ks2e bare relay, which has no separate VCC rail — unlike an opto relay module.)
    pins: [
      { name: 'sig', type: 'digital', x: 0, y: 0 },
      { name: 'gnd', type: 'ground', x: 0, y: 32 },
    ],
    properties: [
      {
        name: 'activeLow',
        label: 'Active LOW',
        type: 'boolean',
        default: false,
        control: 'boolean',
      },
    ],
    size: { w: 40, h: 40 },
    build: (c) => {
      const pin = c.digital('sig');
      return pin === undefined
        ? null
        : new Relay(c.id, pin, { activeLow: bool(c.props, 'activeLow', false) });
    },
  },

  servo: {
    type: 'servo',
    displayName: 'Servo (SG90)',
    category: 'actuator',
    description: 'SG90 hobby servo; angle decoded from the PWM pulse width on the signal pin.',
    tags: ['servo', 'sg90', 'pwm', 'actuator', 'output'],
    kind: 'servo',
    pins: [
      { name: 'sig', type: 'digital', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 0, y: 24 },
    ],
    properties: [],
    size: { w: 44, h: 32 },
    build: (c) => {
      const pin = c.digital('sig');
      return pin === undefined ? null : new ServoSg90(c.id, pin);
    },
  },

  dht22: {
    type: 'dht22',
    displayName: 'DHT22 (temp/humidity)',
    category: 'sensor',
    description:
      'DHT22 single-wire temperature + humidity sensor. The readings are scene parameters.',
    tags: ['dht22', 'temperature', 'humidity', 'sensor', '1-wire'],
    kind: 'dht22',
    pins: [
      { name: 'sig', type: 'digital', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 0, y: 24 },
    ],
    properties: [
      { name: 'tempC', label: 'Temperature (°C)', type: 'number', default: 24, control: 'number' },
      {
        name: 'humidity',
        label: 'Humidity (%)',
        type: 'number',
        default: 55,
        control: 'number',
        min: 0,
        max: 100,
      },
    ],
    size: { w: 32, h: 40 },
    build: (c) => {
      const pin = c.digital('sig');
      return pin === undefined
        ? null
        : new Dht22(c.id, pin, {
            tempC: num(c.props, 'tempC', 24),
            humidity: num(c.props, 'humidity', 55),
          });
    },
  },

  hcsr04: {
    type: 'hcsr04',
    displayName: 'HC-SR04 (ultrasonic)',
    category: 'sensor',
    description:
      'HC-SR04 ultrasonic range finder. TRIG output + ECHO input; distance is a scene parameter.',
    tags: ['hcsr04', 'ultrasonic', 'distance', 'sensor'],
    kind: 'hcsr04',
    pins: [
      { name: 'trig', type: 'digital', x: 0, y: 0 },
      { name: 'echo', type: 'digital', x: 0, y: 12 },
      { name: 'vcc', type: 'power', x: 0, y: 24 },
      { name: 'gnd', type: 'ground', x: 0, y: 36 },
    ],
    properties: [
      {
        name: 'distanceCm',
        label: 'Distance (cm)',
        type: 'number',
        default: 20,
        control: 'number',
        min: 2,
        max: 400,
        step: 1,
        description: 'Khoảng cách tới vật cản (cm) — quyết định độ rộng xung ECHO',
      },
    ],
    size: { w: 48, h: 44 },
    build: (c) => {
      const trig = c.digital('trig');
      const echo = c.digital('echo');
      if (trig === undefined || echo === undefined) return null;
      const s = new HcSr04(c.id, trig, echo);
      s.distanceCm = num(c.props, 'distanceCm', 20);
      return s;
    },
  },

  'lcd-i2c': {
    type: 'lcd-i2c',
    displayName: 'LCD 16×2 (I²C)',
    category: 'display',
    description: 'HD44780 character LCD behind a PCF8574 I²C backpack.',
    tags: ['lcd', 'display', 'i2c', 'hd44780'],
    kind: 'i2c-device',
    pins: [
      { name: 'sda', type: 'i2c-sda', x: 0, y: 0 },
      { name: 'scl', type: 'i2c-scl', x: 0, y: 12 },
      { name: 'vcc', type: 'power', x: 0, y: 24 },
      { name: 'gnd', type: 'ground', x: 0, y: 36 },
    ],
    properties: [
      {
        name: 'address',
        label: 'I²C address',
        type: 'number',
        default: LCD_I2C_ADDR,
        control: 'number',
      },
    ],
    size: { w: 120, h: 48 },
    build: (c) => new LcdI2c(c.id, coerceI2cAddress(c.props, LCD_I2C_ADDR)),
    i2cAddress: (p) => coerceI2cAddress(p, LCD_I2C_ADDR),
  },

  ssd1306: {
    type: 'ssd1306',
    displayName: 'OLED 128×64 (SSD1306)',
    category: 'display',
    description: 'SSD1306 monochrome OLED over I²C.',
    tags: ['oled', 'ssd1306', 'display', 'i2c'],
    kind: 'i2c-device',
    pins: [
      { name: 'sda', type: 'i2c-sda', x: 0, y: 0 },
      { name: 'scl', type: 'i2c-scl', x: 0, y: 12 },
      { name: 'vcc', type: 'power', x: 0, y: 24 },
      { name: 'gnd', type: 'ground', x: 0, y: 36 },
    ],
    properties: [
      {
        name: 'address',
        label: 'I²C address',
        type: 'number',
        default: SSD1306_I2C_ADDR,
        control: 'number',
      },
    ],
    size: { w: 96, h: 64 },
    build: (c) => new Ssd1306(c.id, coerceI2cAddress(c.props, SSD1306_I2C_ADDR)),
    i2cAddress: (p) => coerceI2cAddress(p, SSD1306_I2C_ADDR),
  },

  ds1307: {
    type: 'ds1307',
    displayName: 'Đồng hồ thời gian thực (DS1307)',
    category: 'sensor',
    description:
      'RTC DS1307 trên bus I²C (0x68). Giữ giây/phút/giờ/ngày/tháng/năm (BCD) và tự chạy 1 giây mỗi giây ảo; sketch đặt/đọc giờ qua RTClib hoặc Wire.',
    tags: ['rtc', 'clock', 'ds1307', 'time', 'i2c'],
    kind: 'i2c-device',
    pins: [
      { name: 'sda', type: 'i2c-sda', x: 0, y: 0 },
      { name: 'scl', type: 'i2c-scl', x: 0, y: 12 },
      { name: 'vcc', type: 'power', x: 0, y: 24 },
      { name: 'gnd', type: 'ground', x: 0, y: 36 },
    ],
    properties: [
      {
        name: 'hour',
        label: 'Giờ (0–23)',
        type: 'number',
        default: 12,
        control: 'number',
        min: 0,
        max: 23,
      },
      {
        name: 'minute',
        label: 'Phút (0–59)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 59,
      },
    ],
    size: { w: 56, h: 48 },
    build: (c) =>
      new Ds1307(c.id, { hour: num(c.props, 'hour', 12), minute: num(c.props, 'minute', 0) }),
    i2cAddress: () => 0x68,
  },

  mpu6050: {
    type: 'mpu6050',
    displayName: 'Cảm biến gia tốc/con quay (MPU6050)',
    category: 'sensor',
    description:
      'IMU 6 trục MPU6050 trên I²C (0x68): WHO_AM_I + thanh ghi gia tốc/nhiệt độ/con quay 16-bit. Nghỉ đọc +1g trên trục Z; nghiêng/lắc đặt qua inspector để sketch đọc vector thật.',
    tags: ['mpu6050', 'imu', 'accelerometer', 'gyroscope', 'i2c', 'motion'],
    kind: 'i2c-device',
    pins: [
      { name: 'sda', type: 'i2c-sda', x: 0, y: 0 },
      { name: 'scl', type: 'i2c-scl', x: 0, y: 12 },
      { name: 'vcc', type: 'power', x: 0, y: 24 },
      { name: 'gnd', type: 'ground', x: 0, y: 36 },
    ],
    properties: [
      {
        name: 'accelX',
        label: 'Gia tốc X (g)',
        type: 'number',
        default: 0,
        control: 'number',
        min: -8,
        max: 8,
        step: 0.1,
      },
      {
        name: 'accelY',
        label: 'Gia tốc Y (g)',
        type: 'number',
        default: 0,
        control: 'number',
        min: -8,
        max: 8,
        step: 0.1,
      },
      {
        name: 'accelZ',
        label: 'Gia tốc Z (g)',
        type: 'number',
        default: 1,
        control: 'number',
        min: -8,
        max: 8,
        step: 0.1,
      },
      { name: 'gyroX', label: 'Con quay X (°/s)', type: 'number', default: 0, control: 'number' },
      { name: 'gyroY', label: 'Con quay Y (°/s)', type: 'number', default: 0, control: 'number' },
      { name: 'gyroZ', label: 'Con quay Z (°/s)', type: 'number', default: 0, control: 'number' },
      { name: 'temp', label: 'Nhiệt độ (°C)', type: 'number', default: 25, control: 'number' },
    ],
    size: { w: 64, h: 40 },
    build: (c) => {
      const m = new Mpu6050(c.id);
      m.setAccel(num(c.props, 'accelX', 0), num(c.props, 'accelY', 0), num(c.props, 'accelZ', 1));
      m.setGyro(num(c.props, 'gyroX', 0), num(c.props, 'gyroY', 0), num(c.props, 'gyroZ', 0));
      m.setTemp(num(c.props, 'temp', 25));
      return m;
    },
    i2cAddress: () => 0x68,
  },

  ws2812: {
    type: 'ws2812',
    displayName: 'WS2812 (NeoPixel)',
    category: 'output',
    description: 'WS2812 addressable RGB LED; single-wire 800 kHz data in.',
    tags: ['ws2812', 'neopixel', 'addressable', 'led', 'output'],
    kind: 'ws2812',
    pins: [
      { name: 'din', type: 'digital', x: 0, y: 0 },
      { name: 'dout', type: 'digital', x: 24, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 16 },
      { name: 'gnd', type: 'ground', x: 24, y: 16 },
    ],
    properties: [],
    size: { w: 32, h: 24 },
    build: (c) => {
      const pin = c.digital('din');
      return pin === undefined ? null : new Ws2812(c.id, pin);
    },
  },

  pir: {
    type: 'pir',
    displayName: 'Cảm biến chuyển động (PIR)',
    category: 'sensor',
    description:
      'Cảm biến hồng ngoại thụ động (HC-SR501) — chân OUT lên HIGH khi phát hiện chuyển động.',
    tags: ['pir', 'motion', 'sensor', 'digital'],
    kind: 'pir',
    pins: [
      { name: 'sig', type: 'digital', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 0, y: 24 },
    ],
    properties: [
      {
        name: 'motion',
        label: 'Phát hiện chuyển động',
        type: 'boolean',
        default: false,
        control: 'boolean',
      },
    ],
    size: { w: 48, h: 48 },
    build: (c) => {
      const pin = c.digital('sig');
      return pin === undefined
        ? null
        : new DigitalSensor(c.id, pin, { active: bool(c.props, 'motion', false) });
    },
  },

  tilt: {
    type: 'tilt',
    displayName: 'Cảm biến nghiêng',
    category: 'sensor',
    description: 'Công tắc nghiêng (tilt switch) — đóng/mở chân OUT khi bị nghiêng.',
    tags: ['tilt', 'switch', 'sensor', 'digital'],
    kind: 'tilt',
    pins: [
      { name: 'sig', type: 'digital', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 0, y: 24 },
    ],
    properties: [
      {
        name: 'tilted',
        label: 'Đang nghiêng',
        type: 'boolean',
        default: false,
        control: 'boolean',
      },
    ],
    size: { w: 40, h: 40 },
    build: (c) => {
      const pin = c.digital('sig');
      return pin === undefined
        ? null
        : new DigitalSensor(c.id, pin, { active: bool(c.props, 'tilted', false) });
    },
  },

  gas: {
    type: 'gas',
    displayName: 'Cảm biến khí gas (MQ-2)',
    category: 'sensor',
    description: 'MQ-2 — chân AOUT cho điện áp analog tỉ lệ nồng độ khí; đọc bằng analogRead.',
    tags: ['gas', 'mq2', 'smoke', 'sensor', 'analog'],
    kind: 'gas',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 0, y: 24 },
    ],
    properties: [
      {
        name: 'level',
        label: 'Nồng độ khí (0–100%)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 100,
      },
    ],
    size: { w: 56, h: 40 },
    build: (c) => {
      const ch = c.analog('sig');
      return ch === undefined
        ? null
        : new AnalogSensor(c.id, ch, { value: num(c.props, 'level', 0) / 100 });
    },
  },

  flame: {
    type: 'flame',
    displayName: 'Cảm biến lửa',
    category: 'sensor',
    description:
      'Cảm biến hồng ngoại phát hiện lửa — chân AOUT analog tỉ lệ cường độ; đọc bằng analogRead.',
    tags: ['flame', 'fire', 'sensor', 'analog'],
    kind: 'flame',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 0, y: 24 },
    ],
    properties: [
      {
        name: 'level',
        label: 'Cường độ lửa (0–100%)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 100,
      },
    ],
    size: { w: 56, h: 40 },
    build: (c) => {
      const ch = c.analog('sig');
      return ch === undefined
        ? null
        : new AnalogSensor(c.id, ch, { value: num(c.props, 'level', 0) / 100 });
    },
  },

  'water-level': {
    type: 'water-level',
    displayName: 'Cảm biến mực nước',
    category: 'sensor',
    // Keyes K-0135 analog water level sensor (per nivel_de_agua_analogico.pdf): DC 5V, <20mA, analog out,
    // detection area 40×16mm. The exposed parallel comb traces bridge as water rises → chân S xuất điện áp
    // analog tỉ lệ chiều dài ngập (đọc bằng analogRead; càng ngập càng cao). Nguồn 5V (VCC → VIN/5V).
    description:
      'Cảm biến mực nước analog Keyes K-0135 (5V) — lược dẫn điện, chân S xuất điện áp tỉ lệ mực nước ngập; đọc bằng analogRead. Càng ngập giá trị càng cao.',
    tags: ['water', 'level', 'liquid', 'sensor', 'analog', 'k-0135'],
    kind: 'water',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 0, y: 24 },
    ],
    properties: [
      {
        name: 'level',
        label: 'Mực nước ngập lược (0–100%)',
        type: 'number',
        default: 40,
        control: 'number',
        min: 0,
        max: 100,
      },
    ],
    size: { w: 108, h: 34 }, // 65×20mm real board → the design's 440×140 art, rendered ~3.25:1
    build: (c) => {
      const ch = c.analog('sig');
      // AnalogSensor's default Vref is 5 V — matches the K-0135's 5 V operation: on a 5 V ADC (Uno) the
      // reading spans 0..1023 (the datasheet's alarm example fires at ~700 ≈ 68 %); on a 3.3 V ADC (ESP32)
      // it saturates above ~66 %, exactly as a 5 V sensor does un-level-shifted. So no Vref override here.
      return ch === undefined
        ? null
        : new AnalogSensor(c.id, ch, { value: num(c.props, 'level', 40) / 100 });
    },
  },

  'slide-potentiometer': {
    type: 'slide-potentiometer',
    displayName: 'Chiết áp trượt',
    category: 'input',
    description:
      'Chiết áp dạng thanh trượt — cùng mô hình chia áp như chiết áp xoay, đọc bằng analogRead.',
    tags: ['slide', 'potentiometer', 'fader', 'analog', 'adc', 'input'],
    kind: 'potentiometer',
    pins: [
      { name: 'vcc', type: 'power', x: 0, y: 0 },
      { name: 'wiper', type: 'analog', x: 16, y: 0 },
      { name: 'gnd', type: 'ground', x: 32, y: 0 },
    ],
    properties: [
      {
        name: 'ohms',
        label: 'Resistance (Ω)',
        type: 'number',
        default: 10000,
        control: 'number',
        min: 0,
      },
    ],
    size: { w: 120, h: 28 },
    build: (c) => {
      const ch = c.analog('wiper');
      return ch === undefined
        ? null
        : new Potentiometer(c.id, ch, { ohms: num(c.props, 'ohms', 10000) });
    },
  },

  'pushbutton-6mm': {
    type: 'pushbutton-6mm',
    displayName: 'Nút nhấn 6mm',
    category: 'input',
    description:
      'Nút nhấn tact 6mm 4 chân (momentary). Kéo chân MCU xuống LOW khi nhấn (dùng INPUT_PULLUP).',
    tags: ['button', 'pushbutton', 'tactile', 'switch', 'input', 'gpio'],
    kind: 'button',
    pins: [
      { name: 'a', type: 'digital', x: 0, y: 8 },
      { name: 'b', type: 'ground', x: 24, y: 8 },
    ],
    properties: [],
    size: { w: 28, h: 24 },
    build: (c) => {
      const pin = c.digital('a') ?? c.digital('b');
      return pin === undefined ? null : new PushButton(c.id, pin);
    },
  },

  'slide-switch': {
    type: 'slide-switch',
    displayName: 'Công tắc gạt',
    category: 'input',
    description:
      'Công tắc gạt SPDT (duy trì trạng thái). Chân chung (sig) nối HIGH/LOW theo vị trí gạt; MCU đọc digitalRead.',
    tags: ['slide', 'switch', 'spdt', 'toggle', 'input', 'digital'],
    kind: 'switch',
    pins: [
      { name: 'a', type: 'power', x: 0, y: 0 },
      { name: 'sig', type: 'digital', x: 16, y: 0 },
      { name: 'b', type: 'ground', x: 32, y: 0 },
    ],
    properties: [
      { name: 'on', label: 'Bật (HIGH)', type: 'boolean', default: false, control: 'boolean' },
    ],
    size: { w: 40, h: 28 },
    build: (c) => {
      const pin = c.digital('sig');
      return pin === undefined
        ? null
        : new DigitalSensor(c.id, pin, { active: bool(c.props, 'on', false) });
    },
  },

  'small-sound-sensor': {
    type: 'small-sound-sensor',
    displayName: 'Cảm biến âm thanh (nhỏ)',
    category: 'sensor',
    description:
      'Mô-đun micro cảm biến âm thanh — chân AOUT cho mức analog tỉ lệ cường độ âm; đọc bằng analogRead.',
    tags: ['sound', 'microphone', 'audio', 'sensor', 'analog'],
    kind: 'sound',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'dout', type: 'digital', x: 16, y: 0 },
      { name: 'vcc', type: 'power', x: 32, y: 0 },
      { name: 'gnd', type: 'ground', x: 48, y: 0 },
    ],
    properties: [
      {
        name: 'level',
        label: 'Cường độ âm (0–100%)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 100,
      },
    ],
    size: { w: 40, h: 32 },
    build: (c) => {
      const ch = c.analog('sig');
      return ch === undefined
        ? null
        : new AnalogSensor(c.id, ch, { value: num(c.props, 'level', 0) / 100 });
    },
  },

  'big-sound-sensor': {
    type: 'big-sound-sensor',
    displayName: 'Cảm biến âm thanh (lớn)',
    category: 'sensor',
    description:
      'Mô-đun cảm biến âm thanh cỡ lớn — chân AOUT cho mức analog tỉ lệ cường độ âm; đọc bằng analogRead.',
    tags: ['sound', 'microphone', 'audio', 'sensor', 'analog'],
    kind: 'sound',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'dout', type: 'digital', x: 16, y: 0 },
      { name: 'vcc', type: 'power', x: 32, y: 0 },
      { name: 'gnd', type: 'ground', x: 48, y: 0 },
    ],
    properties: [
      {
        name: 'level',
        label: 'Cường độ âm (0–100%)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 100,
      },
    ],
    size: { w: 56, h: 40 },
    build: (c) => {
      const ch = c.analog('sig');
      return ch === undefined
        ? null
        : new AnalogSensor(c.id, ch, { value: num(c.props, 'level', 0) / 100 });
    },
  },

  'heart-beat-sensor': {
    type: 'heart-beat-sensor',
    displayName: 'Cảm biến nhịp tim',
    category: 'sensor',
    description:
      'Cảm biến nhịp tim quang học — chân OUT cho mức analog của tín hiệu mạch đập; đọc bằng analogRead.',
    tags: ['heartbeat', 'pulse', 'heart', 'sensor', 'analog'],
    kind: 'pulse',
    pins: [
      { name: 'sig', type: 'analog', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 16, y: 0 },
      { name: 'gnd', type: 'ground', x: 32, y: 0 },
    ],
    properties: [
      {
        name: 'level',
        label: 'Biên độ mạch (0–100%)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 100,
      },
    ],
    size: { w: 40, h: 32 },
    build: (c) => {
      const ch = c.analog('sig');
      return ch === undefined
        ? null
        : new AnalogSensor(c.id, ch, { value: num(c.props, 'level', 0) / 100 });
    },
  },

  'led-ring': {
    type: 'led-ring',
    displayName: 'Vòng LED (NeoPixel)',
    category: 'output',
    description: 'Vòng LED RGB địa chỉ (WS2812). Một dây dữ liệu DIN nối tiếp, 800 kHz.',
    tags: ['led-ring', 'neopixel', 'ws2812', 'addressable', 'ring', 'output'],
    kind: 'ws2812',
    pins: [
      { name: 'din', type: 'digital', x: 0, y: 0 },
      { name: 'dout', type: 'digital', x: 24, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 16 },
      { name: 'gnd', type: 'ground', x: 24, y: 16 },
    ],
    properties: [],
    size: { w: 64, h: 64 },
    build: (c) => {
      const pin = c.digital('din');
      return pin === undefined ? null : new Ws2812(c.id, pin);
    },
  },

  'neopixel-matrix': {
    type: 'neopixel-matrix',
    displayName: 'Ma trận NeoPixel',
    category: 'output',
    description: 'Ma trận LED RGB địa chỉ (WS2812). Một dây dữ liệu DIN nối tiếp, 800 kHz.',
    tags: ['neopixel', 'ws2812', 'matrix', 'addressable', 'output'],
    kind: 'ws2812',
    pins: [
      { name: 'din', type: 'digital', x: 0, y: 0 },
      { name: 'dout', type: 'digital', x: 24, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 16 },
      { name: 'gnd', type: 'ground', x: 24, y: 16 },
    ],
    properties: [],
    size: { w: 64, h: 64 },
    build: (c) => {
      const pin = c.digital('din');
      return pin === undefined ? null : new Ws2812(c.id, pin);
    },
  },

  lcd2004: {
    type: 'lcd2004',
    displayName: 'LCD 20×4 (I²C)',
    category: 'display',
    description: 'HD44780 character LCD 20×4 behind a PCF8574 I²C backpack.',
    tags: ['lcd', 'lcd2004', 'display', 'i2c', 'hd44780'],
    kind: 'i2c-device',
    pins: [
      { name: 'sda', type: 'i2c-sda', x: 0, y: 0 },
      { name: 'scl', type: 'i2c-scl', x: 0, y: 12 },
      { name: 'vcc', type: 'power', x: 0, y: 24 },
      { name: 'gnd', type: 'ground', x: 0, y: 36 },
    ],
    properties: [
      {
        name: 'address',
        label: 'I²C address',
        type: 'number',
        default: LCD_I2C_ADDR,
        control: 'number',
      },
    ],
    size: { w: 150, h: 60 },
    build: (c) => new LcdI2c(c.id, coerceI2cAddress(c.props, LCD_I2C_ADDR)),
    i2cAddress: (p) => coerceI2cAddress(p, LCD_I2C_ADDR),
  },

  'seven-segment': {
    type: 'seven-segment',
    displayName: 'LED 7 đoạn',
    category: 'display',
    description:
      'LED 7 đoạn 1 chữ số (8 chân: a–g + dp). Mỗi đoạn sáng theo GPIO; cathode chung sáng mức HIGH, anode chung sáng mức LOW. Mô hình giải mã chữ số đang hiển thị.',
    tags: ['7segment', 'seven-segment', 'display', 'digit', 'led', 'output'],
    kind: 'seg7',
    pins: [
      { name: 'a', type: 'digital', x: 0, y: 0 },
      { name: 'b', type: 'digital', x: 8, y: 0 },
      { name: 'c', type: 'digital', x: 16, y: 0 },
      { name: 'd', type: 'digital', x: 24, y: 0 },
      { name: 'e', type: 'digital', x: 0, y: 12 },
      { name: 'f', type: 'digital', x: 8, y: 12 },
      { name: 'g', type: 'digital', x: 16, y: 12 },
      { name: 'dp', type: 'digital', x: 24, y: 12 },
      { name: 'com', type: 'ground', x: 12, y: 24 },
    ],
    properties: [
      {
        name: 'commonCathode',
        label: 'Cực âm chung (common-cathode)',
        type: 'boolean',
        default: true,
        control: 'boolean',
      },
    ],
    size: { w: 48, h: 64 },
    build: (c) => {
      const a = c.digital('a');
      const b = c.digital('b');
      const cc = c.digital('c');
      const d = c.digital('d');
      const e = c.digital('e');
      const f = c.digital('f');
      const g = c.digital('g');
      if ([a, b, cc, d, e, f, g].some((x) => x === undefined)) return null; // need all 7 segments
      return new SevenSegment(
        c.id,
        { a: a!, b: b!, c: cc!, d: d!, e: e!, f: f!, g: g!, dp: c.digital('dp') },
        { commonCathode: bool(c.props, 'commonCathode', true) },
      );
    },
  },

  'analog-joystick': {
    type: 'analog-joystick',
    displayName: 'Cần điều khiển (joystick)',
    category: 'input',
    description:
      'Joystick 2 trục analog (KY-023): VERT/HORZ vào 2 kênh ADC + nút nhấn SEL (active-low). Nghỉ ở giữa (~mid-scale).',
    tags: ['joystick', 'analog', 'adc', '2-axis', 'input'],
    kind: 'joystick',
    pins: [
      { name: 'vert', type: 'analog', x: 0, y: 0 },
      { name: 'horz', type: 'analog', x: 16, y: 0 },
      { name: 'sel', type: 'digital', x: 32, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 16 },
      { name: 'gnd', type: 'ground', x: 16, y: 16 },
    ],
    properties: [
      {
        name: 'horizontal',
        label: 'Trục ngang (0–100%)',
        type: 'number',
        default: 50,
        control: 'number',
        min: 0,
        max: 100,
      },
      {
        name: 'vertical',
        label: 'Trục dọc (0–100%)',
        type: 'number',
        default: 50,
        control: 'number',
        min: 0,
        max: 100,
      },
      { name: 'pressed', label: 'Nhấn nút', type: 'boolean', default: false, control: 'boolean' },
    ],
    size: { w: 64, h: 64 },
    build: (c) => {
      const vert = c.analog('vert');
      const horz = c.analog('horz');
      if (vert === undefined || horz === undefined) return null;
      const js = new Joystick(c.id, { vert, horz, sel: c.digital('sel') });
      js.setHorz(num(c.props, 'horizontal', 50) / 100);
      js.setVert(num(c.props, 'vertical', 50) / 100);
      js.setPressed(bool(c.props, 'pressed', false));
      return js;
    },
  },

  'dip-switch-8': {
    type: 'dip-switch-8',
    displayName: 'Công tắc DIP (8)',
    category: 'input',
    description:
      '8 công tắc SPST độc lập. Mỗi công tắc đóng nối chân a (MCU, INPUT_PULLUP) xuống b (GND) → đọc LOW; mở → pull-up đọc HIGH.',
    tags: ['dip', 'switch', 'dip-switch', '8', 'input', 'digital'],
    kind: 'dipswitch',
    pins: [
      ...Array.from({ length: 8 }, (_, i) => ({
        name: `a${i + 1}`,
        type: 'digital' as PinType,
        x: i * 8,
        y: 0,
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        name: `b${i + 1}`,
        type: 'ground' as PinType,
        x: i * 8,
        y: 24,
      })),
    ],
    properties: Array.from({ length: 8 }, (_, i) => ({
      name: `sw${i + 1}`,
      label: `SW${i + 1}`,
      type: 'boolean' as const,
      default: false,
      control: 'boolean' as PropControl,
    })),
    size: { w: 80, h: 36 },
    build: (c) => {
      const pins = Array.from({ length: 8 }, (_, i) => c.digital(`a${i + 1}`));
      if (pins.every((p) => p === undefined)) return null;
      return new DipSwitch(c.id, pins, {
        on: Array.from({ length: 8 }, (_, i) => bool(c.props, `sw${i + 1}`, false)),
      });
    },
  },

  'led-bar-graph': {
    type: 'led-bar-graph',
    displayName: 'Thanh LED (10)',
    category: 'output',
    description:
      '10 LED độc lập thành một thanh (VU-meter). Mỗi anode là 1 GPIO; sáng khi chân HIGH (cathode về GND).',
    tags: ['led-bar', 'bargraph', 'vu-meter', '10', 'led', 'output'],
    kind: 'ledbar',
    pins: [
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `a${i + 1}`,
        type: 'digital' as PinType,
        x: i * 8,
        y: 0,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `c${i + 1}`,
        type: 'ground' as PinType,
        x: i * 8,
        y: 24,
      })),
    ],
    properties: [],
    size: { w: 96, h: 36 },
    build: (c) => {
      const anodes = Array.from({ length: 10 }, (_, i) => c.digital(`a${i + 1}`));
      if (anodes.every((p) => p === undefined)) return null;
      return new LedBarGraph(c.id, anodes);
    },
  },

  'ky-040': {
    type: 'ky-040',
    displayName: 'Encoder xoay (KY-040)',
    category: 'input',
    description:
      'Bộ mã hoá xoay tăng dần: 2 ngõ vuông pha CLK/DT + nút SW. Xoay CW thì CLK dẫn pha, CCW thì DT dẫn (đọc DT tại sườn xuống CLK).',
    tags: ['encoder', 'rotary', 'ky-040', 'quadrature', 'input'],
    kind: 'encoder',
    pins: [
      { name: 'clk', type: 'digital', x: 0, y: 0 },
      { name: 'dt', type: 'digital', x: 12, y: 0 },
      { name: 'sw', type: 'digital', x: 24, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 16 },
      { name: 'gnd', type: 'ground', x: 24, y: 16 },
    ],
    properties: [
      {
        name: 'position',
        label: 'Vị trí (số nấc)',
        type: 'number',
        default: 0,
        control: 'number',
        step: 1,
      },
      { name: 'pressed', label: 'Nhấn nút', type: 'boolean', default: false, control: 'boolean' },
    ],
    size: { w: 48, h: 48 },
    build: (c) => {
      const clk = c.digital('clk');
      const dt = c.digital('dt');
      if (clk === undefined || dt === undefined) return null;
      const enc = new RotaryEncoder(c.id, { clk, dt, sw: c.digital('sw') });
      enc.setPressed(bool(c.props, 'pressed', false));
      return enc;
    },
  },

  'stepper-motor': {
    type: 'stepper-motor',
    displayName: 'Động cơ bước',
    category: 'actuator',
    description:
      'Động cơ bước lưỡng cực 4 dây (A+/A−/B+/B−). Quay theo trình tự cấp điện cuộn dây: firmware (thư viện Stepper hoặc vòng 4/8 bước) đẩy trục quay đúng chiều, đúng số bước.',
    tags: ['stepper', 'motor', 'actuator', 'rotation'],
    kind: 'stepper',
    pins: [
      { name: 'aPlus', type: 'digital', x: 0, y: 0 },
      { name: 'aMinus', type: 'digital', x: 8, y: 0 },
      { name: 'bPlus', type: 'digital', x: 16, y: 0 },
      { name: 'bMinus', type: 'digital', x: 24, y: 0 },
    ],
    properties: [
      {
        name: 'stepsPerRev',
        label: 'Số bước/vòng',
        type: 'number',
        default: 2048,
        control: 'number',
        min: 4,
      },
    ],
    size: { w: 64, h: 64 },
    build: (c) => {
      const pins = {
        aPlus: c.digital('aPlus'),
        aMinus: c.digital('aMinus'),
        bPlus: c.digital('bPlus'),
        bMinus: c.digital('bMinus'),
      };
      if (Object.values(pins).every((p) => p === undefined)) return null;
      return new StepperMotor(c.id, pins, num(c.props, 'stepsPerRev', 2048));
    },
  },

  'biaxial-stepper': {
    type: 'biaxial-stepper',
    displayName: 'Động cơ bước 2 trục',
    category: 'actuator',
    description:
      'Hai động cơ bước lưỡng cực độc lập (trục 1: A1±/B1±, trục 2: A2±/B2±) — kiểu máy vẽ/CNC. Mỗi trục quay theo trình tự cuộn dây riêng.',
    tags: ['stepper', 'biaxial', 'motor', 'plotter', 'cnc', 'actuator'],
    kind: 'stepper',
    pins: [
      { name: 'a1Plus', type: 'digital', x: 0, y: 0 },
      { name: 'a1Minus', type: 'digital', x: 8, y: 0 },
      { name: 'b1Plus', type: 'digital', x: 16, y: 0 },
      { name: 'b1Minus', type: 'digital', x: 24, y: 0 },
      { name: 'a2Plus', type: 'digital', x: 0, y: 12 },
      { name: 'a2Minus', type: 'digital', x: 8, y: 12 },
      { name: 'b2Plus', type: 'digital', x: 16, y: 12 },
      { name: 'b2Minus', type: 'digital', x: 24, y: 12 },
    ],
    properties: [
      {
        name: 'stepsPerRev',
        label: 'Số bước/vòng',
        type: 'number',
        default: 2048,
        control: 'number',
        min: 4,
      },
    ],
    size: { w: 80, h: 80 },
    build: (c) => {
      const p1 = {
        aPlus: c.digital('a1Plus'),
        aMinus: c.digital('a1Minus'),
        bPlus: c.digital('b1Plus'),
        bMinus: c.digital('b1Minus'),
      };
      const p2 = {
        aPlus: c.digital('a2Plus'),
        aMinus: c.digital('a2Minus'),
        bPlus: c.digital('b2Plus'),
        bMinus: c.digital('b2Minus'),
      };
      if ([...Object.values(p1), ...Object.values(p2)].every((p) => p === undefined)) return null;
      return new BiaxialStepper(c.id, p1, p2, num(c.props, 'stepsPerRev', 2048));
    },
  },

  'membrane-keypad': {
    type: 'membrane-keypad',
    displayName: 'Bàn phím màng 4×4',
    category: 'input',
    description:
      'Bàn phím ma trận 4×4 (4 hàng R1–R4 × 4 cột C1–C4). Nhấn phím nối hàng↔cột: khi firmware quét kéo hàng xuống LOW, cột đọc LOW — đúng ma trận thư viện Keypad giải mã. Chọn phím giữ ở inspector.',
    tags: ['keypad', 'matrix', 'membrane', '4x4', 'input'],
    kind: 'keypad',
    pins: [
      ...['r1', 'r2', 'r3', 'r4'].map((name, i) => ({
        name,
        type: 'digital' as PinType,
        x: i * 8,
        y: 0,
      })),
      ...['c1', 'c2', 'c3', 'c4'].map((name, i) => ({
        name,
        type: 'digital' as PinType,
        x: i * 8,
        y: 12,
      })),
    ],
    properties: [
      {
        name: 'key',
        label: 'Phím đang giữ',
        type: 'string',
        default: '',
        control: 'select',
        options: ['', ...KEYPAD_4X4],
      },
    ],
    size: { w: 96, h: 112 },
    build: (c) => {
      const rows = ['r1', 'r2', 'r3', 'r4'].map((n) => c.digital(n));
      const cols = ['c1', 'c2', 'c3', 'c4'].map((n) => c.digital(n));
      if ([...rows, ...cols].every((p) => p === undefined)) return null;
      const kp = new MembraneKeypad(c.id, rows, cols);
      kp.setKey(String(c.props.key ?? ''));
      return kp;
    },
  },

  hx711: {
    type: 'hx711',
    displayName: 'HX711 (loadcell ADC)',
    category: 'sensor',
    description:
      'Bộ khuếch đại + ADC 24-bit cho loadcell (cân). 2 dây SCK/DT: firmware xung SCK 24 lần, HX711 dịch ra từng bit trên DT (MSB trước); DT=LOW báo có dữ liệu. Đặt giá trị đọc ở inspector.',
    tags: ['hx711', 'loadcell', 'adc', 'weight', 'scale', 'sensor'],
    kind: 'loadcell',
    pins: [
      { name: 'dt', type: 'digital', x: 0, y: 0 },
      { name: 'sck', type: 'digital', x: 12, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 12, y: 12 },
    ],
    properties: [
      {
        name: 'raw',
        label: 'Giá trị thô (24-bit)',
        type: 'number',
        default: 0x100000,
        control: 'number',
      },
    ],
    size: { w: 40, h: 56 },
    build: (c) => {
      const dt = c.digital('dt');
      const sck = c.digital('sck');
      if (dt === undefined || sck === undefined) return null;
      const h = new Hx711(c.id, dt, sck);
      h.setRaw(num(c.props, 'raw', 0x100000));
      return h;
    },
  },

  'rotary-dialer': {
    type: 'rotary-dialer',
    displayName: 'Đĩa quay số điện thoại',
    category: 'input',
    description:
      'Đĩa quay số kiểu điện thoại cũ (quay số xung). Quay chữ số N phát N xung LOW trên chân PULSE (~10 xung/giây), chân DIAL đóng khi đang quay; firmware đếm xung để giải mã. Chọn số quay ở inspector.',
    tags: ['rotary', 'dialer', 'phone', 'pulse', 'input'],
    kind: 'dialer',
    pins: [
      { name: 'pulse', type: 'digital', x: 0, y: 0 },
      { name: 'dial', type: 'digital', x: 12, y: 0 },
      { name: 'gnd', type: 'ground', x: 24, y: 0 },
    ],
    properties: [
      {
        name: 'digit',
        label: 'Quay số (0–9)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 9,
      },
    ],
    size: { w: 72, h: 72 },
    build: (c) => {
      const pulse = c.digital('pulse');
      if (pulse === undefined) return null;
      return new RotaryDialer(c.id, pulse, c.digital('dial'));
    },
  },

  'ir-receiver': {
    type: 'ir-receiver',
    displayName: 'Mắt thu hồng ngoại (IR)',
    category: 'sensor',
    description:
      'Mắt thu hồng ngoại (VS1838B) — chân DAT xuất khung NEC đã giải điều chế (active-LOW) để firmware giải mã bằng thư viện IRremote. Phát mã từ inspector hoặc từ điều khiển IR cùng mạch.',
    tags: ['ir', 'infrared', 'receiver', 'nec', 'remote', 'sensor'],
    kind: 'ir',
    pins: [
      { name: 'dat', type: 'digital', x: 0, y: 0 },
      { name: 'vcc', type: 'power', x: 12, y: 0 },
      { name: 'gnd', type: 'ground', x: 24, y: 0 },
    ],
    properties: [
      {
        name: 'command',
        label: 'Mã lệnh NEC (0–255)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 255,
      },
    ],
    size: { w: 32, h: 32 },
    build: (c) => {
      const dat = c.digital('dat');
      return dat === undefined ? null : new IrReceiver(c.id, dat);
    },
  },

  'ir-remote': {
    type: 'ir-remote',
    displayName: 'Điều khiển hồng ngoại (IR)',
    category: 'input',
    description:
      'Điều khiển từ xa hồng ngoại (không nối dây MCU, như thật). Nhấn phím phát mã NEC tới MỌI mắt thu IR trong cùng mạch để firmware giải mã. Chọn phím ở inspector.',
    tags: ['ir', 'infrared', 'remote', 'nec', 'transmitter', 'input'],
    kind: 'ir',
    pins: [], // wireless transmitter: no MCU wiring (drives same-circuit IR receivers)
    properties: [
      {
        name: 'key',
        label: 'Phím (mã NEC 0–255)',
        type: 'number',
        default: 0,
        control: 'number',
        min: 0,
        max: 255,
      },
    ],
    size: { w: 48, h: 96 },
    build: (c) => new IrRemote(c.id),
  },

  ili9341: {
    type: 'ili9341',
    displayName: 'Màn hình TFT 2.8" (ILI9341)',
    category: 'display',
    description:
      'Màn hình TFT SPI 240×320 (ILI9341). Chọn bằng CS, chân D/C phân biệt lệnh/dữ liệu. Giải mã CASET/PASET/RAMWR (thư viện Adafruit_GFX/TFT_eSPI) → vẽ pixel RGB565 thật vào khung hình. MOSI/SCK là bus SPI phần cứng.',
    tags: ['tft', 'display', 'ili9341', 'spi', 'lcd', 'graphics'],
    kind: 'tft',
    pins: [
      { name: 'cs', type: 'digital', x: 0, y: 0 },
      { name: 'dc', type: 'digital', x: 12, y: 0 },
      { name: 'mosi', type: 'digital', x: 24, y: 0 },
      { name: 'sck', type: 'digital', x: 36, y: 0 },
      { name: 'miso', type: 'digital', x: 48, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 12, y: 12 },
    ],
    properties: [],
    size: { w: 120, h: 160 },
    build: (c) => new Ili9341(c.id, c.digital('cs'), c.digital('dc')),
  },

  'microsd-card': {
    type: 'microsd-card',
    displayName: 'Thẻ nhớ microSD',
    category: 'sensor',
    description:
      'Khe thẻ microSD giao tiếp SPI. Mô phỏng đủ trình tự init (CMD0→CMD8→ACMD41→CMD58) + đọc/ghi block (CMD17/CMD24) trên ảnh đĩa FAT16 có sẵn một tệp mẫu, để thư viện SD mount và đọc/ghi tệp thật.',
    tags: ['microsd', 'sd', 'card', 'spi', 'storage', 'fat'],
    kind: 'sdcard',
    pins: [
      { name: 'cs', type: 'digital', x: 0, y: 0 },
      { name: 'mosi', type: 'digital', x: 12, y: 0 },
      { name: 'miso', type: 'digital', x: 24, y: 0 },
      { name: 'sck', type: 'digital', x: 36, y: 0 },
      { name: 'vcc', type: 'power', x: 0, y: 12 },
      { name: 'gnd', type: 'ground', x: 12, y: 12 },
    ],
    properties: [],
    size: { w: 80, h: 64 },
    build: (c) => new MicroSdCard(c.id, c.digital('cs')),
  },

  breadboard: {
    type: 'breadboard',
    displayName: 'Breadboard (400 lỗ)',
    category: 'passive',
    description:
      'Breadboard nửa (400 lỗ): mỗi cột nửa-trên {a–e} là 1 net, nửa-dưới {f–j} là 1 net; 4 thanh nguồn (+/−) chạy dọc. Cắm nhiều chân vào cùng nhóm = nối chung mà không cần dây. Không phải linh kiện tích cực (netlist-only).',
    tags: ['breadboard', 'protoboard', 'passive', 'wiring'],
    kind: 'breadboard',
    // Catalog "pins" are the electrical NET GROUPS (the nodes the netlist references). The visual element
    // exposes the individual holes (a1..j30, rails) + the canvas→document bridge maps hole → group.
    pins: breadboardGroups().map((name) => ({ name, type: 'digital' as PinType, x: 0, y: 0 })),
    properties: [],
    size: { w: 420, h: 170 },
    build: () => null, // passive: pure wiring substrate (row-nets injected by the bridge), no runtime model
  },
} satisfies Record<string, ComponentCatalogEntry>;

/** Literal union of every catalog component type id (drives the device-runtime registry lock). */
export type CatalogComponentType = keyof typeof COMPONENT_CATALOG;

/** A string-indexable view of the catalog (the literal-keyed const has no string index signature). */
const CATALOG_BY_ID = COMPONENT_CATALOG as Record<string, ComponentCatalogEntry>;

/** All catalog component type ids. */
export const CATALOG_TYPES: string[] = Object.keys(COMPONENT_CATALOG);

export function catalogEntry(type: string): ComponentCatalogEntry | undefined {
  return CATALOG_BY_ID[type];
}

/** Default props for a freshly placed component of `type` (from its catalog property defaults). */
export function defaultPropsFor(type: string): Record<string, PropValue> {
  const entry = CATALOG_BY_ID[type];
  if (!entry) return {};
  return Object.fromEntries(entry.properties.map((p) => [p.name, p.default]));
}

/**
 * Per-type UI/bridge data — the SINGLE place the canvas, the wokwi visual layer and the canvas→document
 * bridge read their per-component metadata from (co-located with the catalog so adding a device is ONE
 * file, never a switch scattered across packages). All three are DATA only (strings, no DOM): the wokwi
 * tag/pin-name strings are resolved against the installed @wokwi/elements at UI-build time via each
 * element's runtime `pinInfo`, keeping them in sync with the vendored version.
 *
 * THE LOCK: `WOKWI_ELEMENT` and `COMPONENT_PIN_ALIAS` are mapped types over `CatalogComponentType`, so a
 * NEW catalog entry fails to type-check here until its wokwi tag + pin alias are declared — you cannot
 * ship a drawable device whose wires silently fail to resolve or that has no visual. `INTERACTION` is a
 * partial map (most parts have no live stimulus); `catalog.test.ts` validates its pins + alias targets.
 */
export const WOKWI_ELEMENT: { [T in CatalogComponentType]: string } = {
  led: 'wokwi-led',
  'rgb-led': 'wokwi-rgb-led',
  resistor: 'wokwi-resistor',
  button: 'wokwi-pushbutton',
  potentiometer: 'wokwi-potentiometer',
  ldr: 'wokwi-photoresistor-sensor',
  ntc: 'wokwi-ntc-temperature-sensor',
  buzzer: 'wokwi-buzzer',
  relay: 'wokwi-ks2e-m-dc5',
  servo: 'wokwi-servo',
  dht22: 'wokwi-dht22',
  hcsr04: 'wokwi-hc-sr04',
  'lcd-i2c': 'wokwi-lcd1602',
  ssd1306: 'wokwi-ssd1306',
  ds1307: 'wokwi-ds1307',
  mpu6050: 'wokwi-mpu6050',
  ws2812: 'wokwi-neopixel',
  pir: 'wokwi-pir-motion-sensor',
  tilt: 'wokwi-tilt-switch',
  gas: 'wokwi-gas-sensor',
  flame: 'wokwi-flame-sensor',
  'water-level': 'sparklab-water-sensor', // vendored (wokwi has none) — packages/app/src/lib/water-sensor-element.ts
  'slide-potentiometer': 'wokwi-slide-potentiometer',
  'pushbutton-6mm': 'wokwi-pushbutton-6mm',
  'slide-switch': 'wokwi-slide-switch',
  'small-sound-sensor': 'wokwi-small-sound-sensor',
  'big-sound-sensor': 'wokwi-big-sound-sensor',
  'heart-beat-sensor': 'wokwi-heart-beat-sensor',
  'led-ring': 'wokwi-led-ring',
  'neopixel-matrix': 'wokwi-neopixel-matrix',
  lcd2004: 'wokwi-lcd2004',
  'seven-segment': 'wokwi-7segment',
  'analog-joystick': 'wokwi-analog-joystick',
  'dip-switch-8': 'wokwi-dip-switch-8',
  'led-bar-graph': 'wokwi-led-bar-graph',
  'ky-040': 'wokwi-ky-040',
  'stepper-motor': 'wokwi-stepper-motor',
  'biaxial-stepper': 'wokwi-biaxial-stepper',
  'membrane-keypad': 'wokwi-membrane-keypad',
  hx711: 'wokwi-hx711',
  'rotary-dialer': 'wokwi-rotary-dialer',
  'ir-receiver': 'wokwi-ir-receiver',
  'ir-remote': 'wokwi-ir-remote',
  ili9341: 'wokwi-ili9341',
  'microsd-card': 'wokwi-microsd-card',
  // breadboard: NOT in @wokwi/elements — our own vendored visual element (see app/lib/breadboard-element).
  breadboard: 'sparklab-breadboard',
};

/**
 * wokwi element pin name → catalog pin name, per type (e.g. led A/C → anode/cathode). The canvas→document
 * bridge uses it to reconcile the wokwi-named wires onto the schematic's catalog pin names so the same
 * truth engine runs. A wokwi pin absent from a type's map has no catalog equivalent and is dropped.
 */
export const COMPONENT_PIN_ALIAS: { [T in CatalogComponentType]: Record<string, string> } = {
  led: { A: 'anode', C: 'cathode' },
  'rgb-led': { R: 'r', G: 'g', B: 'b', COM: 'common' },
  resistor: { '1': 'a', '2': 'b' },
  button: { '1.l': 'a', '1.r': 'a', '2.l': 'b', '2.r': 'b' },
  potentiometer: { VCC: 'vcc', SIG: 'wiper', GND: 'gnd' },
  ldr: { AO: 'sig', VCC: 'vcc', GND: 'gnd' },
  ntc: { OUT: 'sig', VCC: 'vcc', GND: 'gnd' },
  buzzer: { '1': 'pos', '2': 'neg' },
  servo: { PWM: 'sig', 'V+': 'vcc', GND: 'gnd' },
  dht22: { SDA: 'sig', VCC: 'vcc', GND: 'gnd' },
  hcsr04: { TRIG: 'trig', ECHO: 'echo', VCC: 'vcc', GND: 'gnd' },
  // PIR / tilt: OUT is the digital signal the MCU reads. Gas (MQ-2) / flame: AOUT is the analog reading.
  pir: { OUT: 'sig', VCC: 'vcc', GND: 'gnd' },
  tilt: { OUT: 'sig', VCC: 'vcc', GND: 'gnd' },
  gas: { AOUT: 'sig', VCC: 'vcc', GND: 'gnd' },
  flame: { AOUT: 'sig', VCC: 'vcc', GND: 'gnd' },
  // water-level: the vendored <sparklab-water-sensor> header — S(signal)/+(VCC)/−(GND).
  'water-level': { SIG: 'sig', VCC: 'vcc', GND: 'gnd' },
  'lcd-i2c': { SDA: 'sda', SCL: 'scl', VCC: 'vcc', GND: 'gnd' },
  // ssd1306: the wokwi element is SPI-bodied but DATA/CLK carry the I²C SDA/SCL lines.
  ssd1306: { DATA: 'sda', CLK: 'scl', VIN: 'vcc', '3V3': 'vcc', GND: 'gnd' },
  // ds1307 RTC backpack: I²C SDA/SCL + 5V/GND (SQW unused).
  ds1307: { SDA: 'sda', SCL: 'scl', '5V': 'vcc', GND: 'gnd' },
  // mpu6050 IMU: I²C SDA/SCL + VCC/GND (INT/AD0/XCL/XDA not modelled).
  mpu6050: { SDA: 'sda', SCL: 'scl', VCC: 'vcc', GND: 'gnd' },
  // ws2812 (wokwi neopixel): DIN is the control input, DOUT chains to the next pixel.
  ws2812: { DIN: 'din', DOUT: 'dout', VDD: 'vcc', VSS: 'gnd' },
  // relay (wokwi ks2e bare relay): the coil terminals are the control (COIL1) + return (COIL2).
  relay: { COIL1: 'sig', COIL2: 'gnd' },
  // slide-potentiometer: SIG is the wiper (same divider model as the rotary pot).
  'slide-potentiometer': { VCC: 'vcc', SIG: 'wiper', GND: 'gnd' },
  // pushbutton-6mm (4-pin tact): both left/right legs of each side share a terminal (a / b).
  'pushbutton-6mm': { '1.l': 'a', '1.r': 'a', '2.l': 'b', '2.r': 'b' },
  // slide-switch (SPDT): 2 is the common pole the MCU reads; 1/3 are the throws (to a rail).
  'slide-switch': { '2': 'sig', '1': 'a', '3': 'b' },
  // sound sensors: AOUT is the analog reading; DOUT is the comparator threshold output.
  'small-sound-sensor': { AOUT: 'sig', DOUT: 'dout', VCC: 'vcc', GND: 'gnd' },
  'big-sound-sensor': { AOUT: 'sig', DOUT: 'dout', VCC: 'vcc', GND: 'gnd' },
  // heart-beat: OUT carries the analog pulse waveform.
  'heart-beat-sensor': { OUT: 'sig', VCC: 'vcc', GND: 'gnd' },
  // led-ring / neopixel-matrix (addressable): DIN is the control input, DOUT chains onward.
  'led-ring': { DIN: 'din', DOUT: 'dout', VCC: 'vcc', GND: 'gnd' },
  'neopixel-matrix': { DIN: 'din', DOUT: 'dout', VCC: 'vcc', GND: 'gnd' },
  // lcd2004: same PCF8574 I²C backpack pinout as the 16×2.
  lcd2004: { SDA: 'sda', SCL: 'scl', VCC: 'vcc', GND: 'gnd' },
  // 7-segment: segment pins a–g + DP; COM is the common (single or split COM.1/COM.2 across digit configs).
  'seven-segment': {
    A: 'a',
    B: 'b',
    C: 'c',
    D: 'd',
    E: 'e',
    F: 'f',
    G: 'g',
    DP: 'dp',
    COM: 'com',
    'COM.1': 'com',
    'COM.2': 'com',
  },
  // joystick: 2 analog axes (VERT/HORZ) + the select button.
  'analog-joystick': { VCC: 'vcc', VERT: 'vert', HORZ: 'horz', SEL: 'sel', GND: 'gnd' },
  // dip-switch-8 / led-bar-graph: long, regular pin maps — generated to stay in lock-step with the pins.
  'dip-switch-8': Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`${i + 1}a`, `a${i + 1}`] as [string, string]).concat(
      Array.from({ length: 8 }, (_, i) => [`${i + 1}b`, `b${i + 1}`] as [string, string]),
    ),
  ),
  'led-bar-graph': Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`A${i + 1}`, `a${i + 1}`] as [string, string]).concat(
      Array.from({ length: 10 }, (_, i) => [`C${i + 1}`, `c${i + 1}`] as [string, string]),
    ),
  ),
  'ky-040': { CLK: 'clk', DT: 'dt', SW: 'sw', VCC: 'vcc', GND: 'gnd' },
  // stepper-motor (bipolar): the four coil terminals A±/B±.
  'stepper-motor': { 'A+': 'aPlus', 'A-': 'aMinus', 'B+': 'bPlus', 'B-': 'bMinus' },
  // biaxial-stepper: two coils' terminals (axis 1 = *1, axis 2 = *2).
  'biaxial-stepper': {
    'A1+': 'a1Plus',
    'A1-': 'a1Minus',
    'B1+': 'b1Plus',
    'B1-': 'b1Minus',
    'A2+': 'a2Plus',
    'A2-': 'a2Minus',
    'B2+': 'b2Plus',
    'B2-': 'b2Minus',
  },
  // membrane-keypad: 4 rows + 4 columns of the scan matrix.
  'membrane-keypad': {
    R1: 'r1',
    R2: 'r2',
    R3: 'r3',
    R4: 'r4',
    C1: 'c1',
    C2: 'c2',
    C3: 'c3',
    C4: 'c4',
  },
  // hx711: SCK clock + DT data (+ power).
  hx711: { SCK: 'sck', DT: 'dt', VCC: 'vcc', GND: 'gnd' },
  // rotary-dialer: PULSE train + DIAL off-normal contact.
  'rotary-dialer': { PULSE: 'pulse', DIAL: 'dial', GND: 'gnd' },
  // ir-receiver: DAT is the demodulated data line the MCU reads.
  'ir-receiver': { DAT: 'dat', VCC: 'vcc', GND: 'gnd' },
  // ir-remote: wireless — no wokwi pins to alias.
  'ir-remote': {},
  // ili9341 TFT: CS + D/C GPIOs the model needs; MOSI/SCK/MISO are the hardware SPI bus.
  ili9341: {
    CS: 'cs',
    'D/C': 'dc',
    MOSI: 'mosi',
    SCK: 'sck',
    MISO: 'miso',
    VCC: 'vcc',
    GND: 'gnd',
  },
  // microsd-card: CS gate; DI=MOSI, DO=MISO on the hardware SPI bus.
  'microsd-card': { CS: 'cs', DI: 'mosi', DO: 'miso', SCK: 'sck', VCC: 'vcc', GND: 'gnd' },
  // breadboard: holes are resolved to net groups by the bridge (breadboardGroupOf), not a static alias.
  breadboard: {},
};

/** Live-stimulus interaction per type (see {@link InteractionKind}); absent → no live input control. */
export const INTERACTION: Partial<Record<CatalogComponentType, InteractionKind>> = {
  button: 'button',
  'pushbutton-6mm': 'button',
  potentiometer: 'pot',
  'slide-potentiometer': 'pot',
  ldr: 'analog-sensor',
  ntc: 'analog-sensor',
};

export function wokwiTagFor(type: string): string | undefined {
  return (WOKWI_ELEMENT as Record<string, string>)[type];
}

/** wokwi element pin name → catalog pin name for `type` (empty for an unknown/passive type). */
export function componentPinAlias(type: string): Record<string, string> | undefined {
  return (COMPONENT_PIN_ALIAS as Record<string, Record<string, string>>)[type];
}

/** The live-stimulus interaction kind for `type`, or undefined if it has none. */
export function interactionOf(type: string): InteractionKind | undefined {
  return (INTERACTION as Record<string, InteractionKind | undefined>)[type];
}

/** Operated directly via its own wokwi element while running (press/turn) rather than dragged. */
export function isLiveOperated(type: string): boolean {
  const k = interactionOf(type);
  return k === 'button' || k === 'pot';
}

/** Stimulated by an external analog slider (carries no reading prop; re-seeded on run). */
export function isAnalogSensor(type: string): boolean {
  return interactionOf(type) === 'analog-sensor';
}
