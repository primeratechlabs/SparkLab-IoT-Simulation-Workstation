/**
 * The editable circuit document — the JSON snapshot a drag-and-drop canvas produces and persists
 * (Sparklab's answer to a `.vlx` / schematic file). It is purely DATA: placed components at
 * coordinates + wires between pins. It carries NO rendering or framework state; the visual design
 * binds to it. The simulator's logical netlist is COMPILED from this (see to-netlist.ts), keeping
 * the "what the user drew" and "what the kernel runs" cleanly separated.
 */

/** Bumped when the persisted document shape changes incompatibly. */
export const SCHEMATIC_SCHEMA_VERSION = 1;

/** 90° canvas rotation steps. */
export type Rotation = 0 | 90 | 180 | 270;

export interface Point {
  x: number;
  y: number;
}

/** A configurable property value on a placed component. */
export type PropValue = string | number | boolean;

/** Electrical role of a pin (mirrors the canonical ComponentPin['type'] in @sparklab/shared). */
export type PinType =
  | 'power'
  | 'ground'
  | 'digital'
  | 'digital-bidirectional'
  | 'analog'
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi'
  | 'uart';

/**
 * A reference to one pin. `component` is a placed component's id, OR the reserved literal
 * `MCU_REF` ('mcu') to address the board's microcontroller pins (e.g. {component:'mcu', pin:'D13'}).
 */
export interface PinRef {
  component: string;
  pin: string;
}

/** The reserved PinRef.component value that addresses the board's MCU header pins. */
export const MCU_REF = 'mcu';

/** A component dropped onto the canvas. `type` indexes COMPONENT_CATALOG. */
export interface PlacedComponent {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation: Rotation;
  /** Catalog-defined properties (resistance, I2C address, sensor reading…). */
  props: Record<string, PropValue>;
}

/** The board instance on the canvas (one per document for now). */
export interface BoardPlacement {
  /** Board catalog id, e.g. 'arduino-uno'. */
  id: string;
  x: number;
  y: number;
  rotation: Rotation;
}

/** A wire connecting two pins, with optional orthogonal routing waypoints + a display colour. */
export interface Wire {
  id: string;
  from: PinRef;
  to: PinRef;
  /** Optional intermediate routing points (for orthogonal wire drawing). */
  waypoints?: Point[];
  /** Optional display colour (signal-type tint); purely visual, ignored by the netlist. */
  color?: string;
}

/** The full editable circuit document. */
export interface CircuitDocument {
  schemaVersion: number;
  id: string;
  name: string;
  board: BoardPlacement;
  components: PlacedComponent[];
  wires: Wire[];
  /** OPFS reference to the firmware source that runs on this circuit (decoupled from the diagram). */
  sketchKey?: string;
  createdAt: number;
  modifiedAt: number;
}
