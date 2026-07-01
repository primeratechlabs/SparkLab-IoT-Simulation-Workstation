/**
 * Device-runtime registry — the single binding from a catalog component TYPE to (a) its runnable
 * `SimComponent` (already produced by `COMPONENT_CATALOG[type].build`) and (b) a `reflect()` reader
 * that exposes the device's VISIBLE state (servo angle, LCD text, LED brightness, …) to the UI.
 *
 * THE ROOT-CAUSE FIX (QA-CURRICULUM CMB-01..04,06,07,09): drawn devices were never attached to the
 * running emulator, so neither stimulus (sensor → firmware) nor reflection (firmware → device) crossed
 * the boundary. The device-runtime layer (this registry + the worker bridge) closes that gap by
 * reusing the EXISTING `SimComponent`/`CircuitHost` contract — every components-core device already
 * implements `attach(host)`; here we add the type→model→reflect binding the worker drives.
 *
 * THE FUTURE-PROOF GUARANTEE (so a NEW device can never silently regress this class):
 *   1. COMPILE-TIME — `DEVICE_RUNTIME` is a mapped type keyed over `DrawableComponentType` (every
 *      non-passive catalog type). Add an entry to `COMPONENT_CATALOG` and the union widens, so this
 *      object literal stops type-checking ("Property 'x' is missing") until a model is registered.
 *      `vue-tsc --noEmit` / `tsc --noEmit` (the build gate) then fails. You cannot ship a catalog
 *      device without a runtime model.
 *   2. TEST-TIME — `device-runtime.test.ts` enumerates the catalog and fails if any drawable type
 *      lacks a model, if a model's kind diverges, or if `reflect()` throws (covers build()-null gaps
 *      the type system can't see).
 */
import type { ComponentKind } from '@sparklab/sim-kernel';
import type { SimComponent } from '@sparklab/components-core';
import {
  Led,
  RgbLed,
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
  Ldr,
  Ntc,
  PushButton,
  Potentiometer,
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
  Hx711,
  RotaryDialer,
  IrReceiver,
  IrRemote,
} from '@sparklab/components-core';
import { COMPONENT_CATALOG, type CatalogComponentType } from './catalog.js';
import { instantiateComponents, type InstantiateIssue } from './instantiate.js';
import type { CircuitDocument } from './types.js';

/** Device-visible state the UI reflects — a SEPARATE channel from firmware `pins` (never electrical
 *  truth; the firmware-driven GPIO snapshot stays authoritative). All fields optional per device. */
export interface DeviceReflection {
  kind: ComponentKind;
  /** digital output devices (LED/relay/buzzer): lit/active. */
  on?: boolean;
  /** LED/relay transition count (handy for tests + the activity counter). */
  toggles?: number;
  /** RGB / WS2812 colour(s). */
  color?: { r: number; g: number; b: number };
  pixels?: { r: number; g: number; b: number }[];
  /** servo shaft angle (deg, -1 until the first pulse). */
  angleDeg?: number;
  /** character LCD text (decoded). */
  text?: string;
  /** OLED / display lit-pixel summary. */
  litPixels?: number;
  width?: number;
  height?: number;
  /** PWM duty as a 0..1 fraction (brightness fidelity — CMB-04). */
  dutyPct?: number;
  /** sensor stimulus echoes (for "the firmware is reading me" feedback). */
  distanceCm?: number;
  triggers?: number;
  pulses?: number;
  volts?: number;
  adc?: number;
  energized?: boolean;
  position?: string;
  switches?: number;
  playing?: boolean;
  frequencyHz?: number;
  [k: string]: unknown;
}

/** A catalog type's runtime binding: its netlist kind (must match the catalog), a reflection reader,
 *  and (optionally) a live inspector-prop applier — all CO-LOCATED with the device here (under the
 *  compile-time lock) so adding a device is one place, not a switch scattered across the codebase. */
export interface DeviceRuntimeModel {
  readonly kind: ComponentKind;
  /** Read the device's visible state. `c` is the instance `COMPONENT_CATALOG[type].build()` produced. */
  reflect(c: SimComponent): DeviceReflection;
  /** Hot-apply an inspector edit (sensor stimulus / actuator setting) to the live component while
   *  running; returns true if applied, false if the prop is construction-time (caller rebuilds). */
  applyProp?(c: SimComponent, name: string, value: unknown): boolean;
}

/** Every catalog type that produces a runnable component. Passives (the resistor + the breadboard, both
 *  netlist-only — the breadboard is a pure wiring substrate) are excluded. Widening `COMPONENT_CATALOG`
 *  widens this union → the registry below must grow too. */
export type DrawableComponentType = Exclude<CatalogComponentType, 'resistor' | 'breadboard'>;

function popcount(b: number): number {
  let n = 0;
  for (let v = b & 0xff; v; v >>= 1) n += v & 1;
  return n;
}

/**
 * The registry. The mapped type `{ [T in DrawableComponentType]: ... }` is the COMPILE-TIME lock:
 * a new drawable catalog type makes this literal fail to type-check until its model is added here.
 */
export const DEVICE_RUNTIME: { [T in DrawableComponentType]: DeviceRuntimeModel } = {
  led: {
    kind: 'led',
    reflect: (c) => {
      const d = c as Led;
      return { kind: 'led', on: d.on, toggles: d.toggles, dutyPct: d.brightness };
    },
  },
  'rgb-led': {
    kind: 'rgb-led',
    reflect: (c) => {
      const d = c as RgbLed;
      return { kind: 'rgb-led', on: d.on, color: d.color };
    },
  },
  button: {
    kind: 'button',
    reflect: () => ({ kind: 'button' }),
    applyProp: (c, name, v) => {
      if (name !== 'pressed') return false;
      (c as PushButton).isPressed = Boolean(v);
      return true;
    },
  },
  potentiometer: {
    kind: 'potentiometer',
    reflect: () => ({ kind: 'potentiometer' }),
    applyProp: (c, name, v) => {
      if (name !== 'position') return false;
      (c as Potentiometer).setPosition(Number(v));
      return true;
    },
  },
  ldr: {
    kind: 'ldr',
    reflect: (c) => {
      const d = c as Ldr;
      return { kind: 'ldr', volts: d.volts, adc: d.adc };
    },
  },
  ntc: {
    kind: 'ntc',
    reflect: (c) => {
      const d = c as Ntc;
      return { kind: 'ntc', volts: d.volts, adc: d.adcRaw };
    },
  },
  buzzer: {
    kind: 'buzzer',
    reflect: (c) => {
      const d = c as Buzzer;
      return { kind: 'buzzer', on: d.playing, playing: d.playing, frequencyHz: d.frequencyHz };
    },
  },
  relay: {
    kind: 'relay',
    reflect: (c) => {
      const d = c as Relay;
      return {
        kind: 'relay',
        on: d.energized,
        energized: d.energized,
        position: d.position,
        switches: d.switches,
      };
    },
  },
  servo: {
    kind: 'servo',
    reflect: (c) => {
      const d = c as ServoSg90;
      return { kind: 'servo', angleDeg: d.angleDeg, pulses: d.pulses };
    },
  },
  dht22: {
    kind: 'dht22',
    reflect: (c) => {
      const d = c as Dht22;
      return { kind: 'dht22', triggers: d.triggers };
    },
    applyProp: (c, name, v) => {
      if (name !== 'tempC' && name !== 'humidity') return false;
      (c as Dht22).setReading({ [name]: Number(v) });
      return true;
    },
  },
  hcsr04: {
    kind: 'hcsr04',
    reflect: (c) => {
      const d = c as HcSr04;
      return { kind: 'hcsr04', distanceCm: d.distanceCm, pulses: d.pulses };
    },
    applyProp: (c, name, v) => {
      if (name !== 'distanceCm') return false;
      (c as HcSr04).distanceCm = Number(v);
      return true;
    },
  },
  pir: {
    kind: 'pir',
    reflect: (c) => {
      const d = c as DigitalSensor;
      return { kind: 'pir', on: d.active };
    },
    applyProp: (c, name, v) => {
      if (name !== 'motion') return false;
      (c as DigitalSensor).setActive(Boolean(v));
      return true;
    },
  },
  tilt: {
    kind: 'tilt',
    reflect: (c) => {
      const d = c as DigitalSensor;
      return { kind: 'tilt', on: d.active };
    },
    applyProp: (c, name, v) => {
      if (name !== 'tilted') return false;
      (c as DigitalSensor).setActive(Boolean(v));
      return true;
    },
  },
  gas: {
    kind: 'gas',
    reflect: (c) => {
      const d = c as AnalogSensor;
      return { kind: 'gas', adc: d.value };
    },
    applyProp: (c, name, v) => {
      if (name !== 'level') return false;
      (c as AnalogSensor).setValue(Number(v) / 100);
      return true;
    },
  },
  flame: {
    kind: 'flame',
    reflect: (c) => {
      const d = c as AnalogSensor;
      return { kind: 'flame', adc: d.value };
    },
    applyProp: (c, name, v) => {
      if (name !== 'level') return false;
      (c as AnalogSensor).setValue(Number(v) / 100);
      return true;
    },
  },
  'lcd-i2c': {
    kind: 'i2c-device',
    reflect: (c) => {
      const d = c as LcdI2c;
      return { kind: 'i2c-device', text: d.text, bytes: d.bytes };
    },
  },
  ssd1306: {
    kind: 'i2c-device',
    reflect: (c) => {
      const d = c as Ssd1306;
      let lit = 0;
      for (const b of d.buffer) lit += popcount(b);
      return { kind: 'i2c-device', width: d.width, height: d.height, litPixels: lit, on: lit > 0 };
    },
  },
  ds1307: {
    kind: 'i2c-device',
    reflect: (c) => ({ kind: 'i2c-device', text: (c as Ds1307).isoTime }),
    applyProp: (c, name, v) => (c as Ds1307).applyField(name, Number(v)),
  },
  mpu6050: {
    kind: 'i2c-device',
    reflect: (c) => ({ kind: 'i2c-device', text: (c as Mpu6050).accelText }),
    applyProp: (c, name, v) => (c as Mpu6050).applyField(name, Number(v)),
  },
  ws2812: {
    kind: 'ws2812',
    reflect: (c) => {
      const d = c as Ws2812;
      return { kind: 'ws2812', pixels: d.pixels.map((p) => ({ r: p.r, g: p.g, b: p.b })) };
    },
  },
  'slide-potentiometer': {
    kind: 'potentiometer',
    reflect: () => ({ kind: 'potentiometer' }),
    applyProp: (c, name, v) => {
      if (name !== 'position') return false;
      (c as Potentiometer).setPosition(Number(v));
      return true;
    },
  },
  'pushbutton-6mm': {
    kind: 'button',
    reflect: () => ({ kind: 'button' }),
    applyProp: (c, name, v) => {
      if (name !== 'pressed') return false;
      (c as PushButton).isPressed = Boolean(v);
      return true;
    },
  },
  'slide-switch': {
    kind: 'switch',
    reflect: (c) => {
      const d = c as DigitalSensor;
      return { kind: 'switch', on: d.active };
    },
    applyProp: (c, name, v) => {
      if (name !== 'on') return false;
      (c as DigitalSensor).setActive(Boolean(v));
      return true;
    },
  },
  'small-sound-sensor': {
    kind: 'sound',
    reflect: (c) => {
      const d = c as AnalogSensor;
      return { kind: 'sound', adc: d.value };
    },
    applyProp: (c, name, v) => {
      if (name !== 'level') return false;
      (c as AnalogSensor).setValue(Number(v) / 100);
      return true;
    },
  },
  'big-sound-sensor': {
    kind: 'sound',
    reflect: (c) => {
      const d = c as AnalogSensor;
      return { kind: 'sound', adc: d.value };
    },
    applyProp: (c, name, v) => {
      if (name !== 'level') return false;
      (c as AnalogSensor).setValue(Number(v) / 100);
      return true;
    },
  },
  'heart-beat-sensor': {
    kind: 'pulse',
    reflect: (c) => {
      const d = c as AnalogSensor;
      return { kind: 'pulse', adc: d.value };
    },
    applyProp: (c, name, v) => {
      if (name !== 'level') return false;
      (c as AnalogSensor).setValue(Number(v) / 100);
      return true;
    },
  },
  'led-ring': {
    kind: 'ws2812',
    reflect: (c) => {
      const d = c as Ws2812;
      return { kind: 'ws2812', pixels: d.pixels.map((p) => ({ r: p.r, g: p.g, b: p.b })) };
    },
  },
  'neopixel-matrix': {
    kind: 'ws2812',
    reflect: (c) => {
      const d = c as Ws2812;
      return { kind: 'ws2812', pixels: d.pixels.map((p) => ({ r: p.r, g: p.g, b: p.b })) };
    },
  },
  lcd2004: {
    kind: 'i2c-device',
    reflect: (c) => {
      const d = c as LcdI2c;
      return { kind: 'i2c-device', text: d.text, bytes: d.bytes };
    },
  },
  'seven-segment': {
    kind: 'seg7',
    reflect: (c) => {
      const d = c as SevenSegment;
      return {
        kind: 'seg7',
        text: d.digit,
        on: Object.values(d.lit).some(Boolean),
        segments: { ...d.lit },
      };
    },
  },
  'analog-joystick': {
    kind: 'joystick',
    reflect: (c) => {
      const d = c as Joystick;
      return { kind: 'joystick', x: d.x, y: d.y, pressed: d.pressed };
    },
    applyProp: (c, name, v) => {
      const d = c as Joystick;
      if (name === 'horizontal') {
        d.setHorz(Number(v) / 100);
        return true;
      }
      if (name === 'vertical') {
        d.setVert(Number(v) / 100);
        return true;
      }
      if (name === 'pressed') {
        d.setPressed(Boolean(v));
        return true;
      }
      return false;
    },
  },
  'dip-switch-8': {
    kind: 'dipswitch',
    reflect: (c) => {
      const d = c as DipSwitch;
      return { kind: 'dipswitch', bits: [...d.on], on: d.on.some(Boolean) };
    },
    applyProp: (c, name, v) => {
      const m = /^sw(\d+)$/.exec(name);
      if (!m) return false;
      (c as DipSwitch).set(Number(m[1]) - 1, Boolean(v));
      return true;
    },
  },
  'led-bar-graph': {
    kind: 'ledbar',
    reflect: (c) => {
      const d = c as LedBarGraph;
      return { kind: 'ledbar', lit: [...d.lit], on: d.count > 0, count: d.count };
    },
  },
  'ky-040': {
    kind: 'encoder',
    reflect: (c) => {
      const d = c as RotaryEncoder;
      return { kind: 'encoder', detents: d.position, pressed: d.pressed };
    },
    applyProp: (c, name, v) => {
      const d = c as RotaryEncoder;
      if (name === 'pressed') {
        d.setPressed(Boolean(v));
        return true;
      }
      if (name === 'position') {
        d.turn(Number(v) - d.position);
        return true;
      }
      return false;
    },
  },
  'stepper-motor': {
    kind: 'stepper',
    reflect: (c) => ({ kind: 'stepper', angleDeg: (c as StepperMotor).angleDeg }),
  },
  'biaxial-stepper': {
    kind: 'stepper',
    reflect: (c) => {
      const d = c as BiaxialStepper;
      return { kind: 'stepper', angleDeg: d.axis1.angleDeg, angle2: d.axis2.angleDeg };
    },
  },
  'membrane-keypad': {
    kind: 'keypad',
    reflect: (c) => ({ kind: 'keypad', key: (c as MembraneKeypad).keyLabel }),
    applyProp: (c, name, v) => {
      if (name !== 'key') return false;
      (c as MembraneKeypad).setKey(String(v ?? ''));
      return true;
    },
  },
  hx711: {
    kind: 'loadcell',
    reflect: (c) => ({ kind: 'loadcell', raw: (c as Hx711).rawValue }),
    applyProp: (c, name, v) => {
      if (name !== 'raw') return false;
      (c as Hx711).setRaw(Number(v));
      return true;
    },
  },
  'rotary-dialer': {
    kind: 'dialer',
    reflect: (c) => ({ kind: 'dialer', digit: (c as RotaryDialer).lastDigit }),
    applyProp: (c, name, v) => {
      if (name !== 'digit') return false;
      (c as RotaryDialer).dial(Number(v));
      return true;
    },
  },
  'ir-receiver': {
    kind: 'ir',
    reflect: (c) => ({ kind: 'ir', command: (c as IrReceiver).lastCommand }),
    applyProp: (c, name, v) => {
      if (name !== 'command') return false;
      (c as IrReceiver).receive(Number(v));
      return true;
    },
  },
  'ir-remote': {
    kind: 'ir',
    reflect: (c) => ({ kind: 'ir', command: (c as IrRemote).lastKey }),
    applyProp: (c, name, v) => {
      if (name !== 'key') return false;
      (c as IrRemote).press(Number(v));
      return true;
    },
  },
};

const RUNTIME_BY_ID = DEVICE_RUNTIME as Record<string, DeviceRuntimeModel>;

/** The runtime model for a type, or undefined for passives/unknown (string-keyed convenience). */
export function deviceRuntimeModel(type: string): DeviceRuntimeModel | undefined {
  return RUNTIME_BY_ID[type];
}

/** Read a live component's visible state, or null if the type has no runtime model (passive). */
export function reflectDevice(type: string, c: SimComponent): DeviceReflection | null {
  return RUNTIME_BY_ID[type]?.reflect(c) ?? null;
}

/** Catalog kinds that are netlist-only (no runtime model): the resistor + the breadboard substrate. */
const PASSIVE_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'resistor',
  'breadboard',
]);

/** Does a catalog type require a runtime model? (Drawable = produces a component; passives don't.) */
export function isDrawableType(type: string): boolean {
  const entry = COMPONENT_CATALOG[type as CatalogComponentType] as
    | { kind: ComponentKind }
    | undefined;
  return entry !== undefined && !PASSIVE_KINDS.has(entry.kind);
}

/** A drawn device, instantiated as a live `SimComponent`, with the catalog type kept for reflection. */
export interface AttachedDevice {
  id: string;
  type: string;
  component: SimComponent;
}

/**
 * Instantiate the drawn document's devices as live `SimComponent`s, keeping each one's catalog TYPE
 * (so the worker can `reflect()` it). This is the bridge input the sim worker attaches to the running
 * emulator — the missing seam that left CMB-01..06 inert. Same topology gate as `instantiateComponents`
 * (an invalid wiring reports an issue instead of attaching a misbehaving device).
 */
export function instantiateAttachedDevices(doc: CircuitDocument): {
  devices: AttachedDevice[];
  issues: InstantiateIssue[];
} {
  const { components, issues } = instantiateComponents(doc);
  const typeOf = new Map(doc.components.map((c) => [c.id, c.type]));
  const devices = components.map((component) => ({
    id: component.id,
    type: typeOf.get(component.id) ?? '',
    component,
  }));
  return { devices, issues };
}

/** Reflect every attached device's visible state into a `cid -> reflection` map for the UI snapshot. */
export function reflectDevices(devices: AttachedDevice[]): Record<string, DeviceReflection> {
  const out: Record<string, DeviceReflection> = {};
  for (const d of devices) {
    const r = reflectDevice(d.type, d.component);
    if (r) out[d.id] = r;
  }
  return out;
}

/**
 * Apply a live inspector edit to an already-attached device — delegated to the per-device `applyProp`
 * declared in `DEVICE_RUNTIME` (co-located + under the compile-time lock), so a new device's live props
 * are added in ONE place, never a central switch. Returns true if applied; false means the prop is
 * construction-time and the caller should rebuild (e.g. a DHT reading baked in at construction).
 */
export function applyDeviceProp(
  type: string,
  c: SimComponent,
  name: string,
  value: unknown,
): boolean {
  return RUNTIME_BY_ID[type]?.applyProp?.(c, name, value) ?? false;
}
