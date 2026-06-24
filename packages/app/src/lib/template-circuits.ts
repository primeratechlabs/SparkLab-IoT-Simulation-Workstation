/**
 * Starter-template circuits (AUD-005). A template is a COMPLETE project — board + sketch + the drawn
 * circuit the sketch talks to — not just code dropped onto an empty canvas. Each circuit here is authored
 * in the editor's own canvas shape (wokwi-named placed parts + wires) and is verified by a test that runs
 * it through the SAME truth engine the product uses (canvasToDocument → componentReadiness), so a template
 * can never ship a circuit the simulator would flag as incomplete.
 *
 * Pin names are wokwi-element names (LED A/C, resistor 1/2, button 1.l/2.l, pot VCC/SIG/GND, board bare
 * numbers / GND.x / 5V); the canvas→document bridge aliases them to catalog names.
 */
import type { SavedCanvas } from './persist';
import { BOARD_CID } from '../composables/useCircuitCanvas';

type PlacedLite = {
  cid: string;
  type: string;
  tag: string;
  x: number;
  y: number;
  rot: number;
  flip: boolean;
  props: Record<string, unknown>;
};
type WireLite = {
  id: string;
  from: { cid: string; pin: string };
  to: { cid: string; pin: string };
  points: never[];
};

const wire = (
  id: string,
  fromCid: string,
  fromPin: string,
  toCid: string,
  toPin: string,
): WireLite => ({
  id,
  from: { cid: fromCid, pin: fromPin },
  to: { cid: toCid, pin: toPin },
  points: [],
});

const canvas = (placed: PlacedLite[], wires: WireLite[]): SavedCanvas => ({
  placed,
  wires,
  boardPos: { x: 40, y: 160 },
  boardRot: 0,
});

/** LED through a series resistor on `dPin`, cathode to GND — the textbook driven-output circuit. */
function ledOnPin(dPin: string, ledColor: string): { placed: PlacedLite[]; wires: WireLite[] } {
  return {
    placed: [
      {
        cid: 'led1',
        type: 'led',
        tag: 'wokwi-led',
        x: 360,
        y: 90,
        rot: 0,
        flip: false,
        props: { color: ledColor },
      },
      {
        cid: 'r1',
        type: 'resistor',
        tag: 'wokwi-resistor',
        x: 260,
        y: 100,
        rot: 0,
        flip: false,
        props: { ohms: 220 },
      },
    ],
    wires: [
      wire('w-led-r', BOARD_CID, dPin, 'r1', '1'),
      wire('w-r-anode', 'r1', '2', 'led1', 'A'),
      wire('w-led-gnd', 'led1', 'C', BOARD_CID, 'GND.1'),
    ],
  };
}

/** Button + LED: press the button (D2 → GND, INPUT_PULLUP) to light the LED on D13. */
export const BUTTON_LED_CANVAS: SavedCanvas = (() => {
  const led = ledOnPin('13', 'red');
  return canvas(
    [
      ...led.placed,
      {
        cid: 'btn1',
        type: 'button',
        tag: 'wokwi-pushbutton',
        x: 360,
        y: 220,
        rot: 0,
        flip: false,
        props: {},
      },
    ],
    [
      ...led.wires,
      wire('w-btn-pin', 'btn1', '1.l', BOARD_CID, '2'),
      wire('w-btn-gnd', 'btn1', '2.l', BOARD_CID, 'GND.2'),
    ],
  );
})();

/** Potentiometer → A0 controls the LED brightness (PWM on D9). Pot rails to 5V/GND. */
export const POT_BRIGHT_CANVAS: SavedCanvas = (() => {
  const led = ledOnPin('9', 'yellow');
  return canvas(
    [
      ...led.placed,
      {
        cid: 'pot1',
        type: 'potentiometer',
        tag: 'wokwi-potentiometer',
        x: 360,
        y: 220,
        rot: 0,
        flip: false,
        props: { ohms: 10000 },
      },
    ],
    [
      ...led.wires,
      wire('w-pot-sig', 'pot1', 'SIG', BOARD_CID, 'A0'),
      wire('w-pot-vcc', 'pot1', 'VCC', BOARD_CID, '5V'),
      wire('w-pot-gnd', 'pot1', 'GND', BOARD_CID, 'GND.2'),
    ],
  );
})();

/**
 * ESP32 Blynk demo circuit: an LED (via a series resistor) on GPIO2, so a dashboard switch on V0 that
 * does digitalWrite(2, …) lights a VISIBLE drawn LED. Without this the firmware drives GPIO2 correctly but
 * nothing on the canvas is mapped to GPIO2 (the ESP32-C3 on-board LED is GPIO8), so the user sees nothing.
 * Board pins use the ESP32-C3 catalog names ('GPIO2', 'GND'); the drawn LED reflects pins[2] at runtime.
 */
export const BLYNK_LED_CANVAS: SavedCanvas = canvas(
  [
    {
      cid: 'led1',
      type: 'led',
      tag: 'wokwi-led',
      x: 380,
      y: 90,
      rot: 0,
      flip: false,
      props: { color: 'blue' },
    },
    {
      cid: 'r1',
      type: 'resistor',
      tag: 'wokwi-resistor',
      x: 280,
      y: 100,
      rot: 0,
      flip: false,
      props: { ohms: 220 },
    },
  ],
  [
    wire('w-blynk-pin', BOARD_CID, 'GPIO2', 'r1', '1'),
    wire('w-blynk-anode', 'r1', '2', 'led1', 'A'),
    wire('w-blynk-gnd', 'led1', 'C', BOARD_CID, 'GND'),
  ],
);

/** NTC thermistor on A0 (voltage divider into the ADC) — the sketch reads it and prints °C. */
export const TEMP_SENSOR_CANVAS: SavedCanvas = canvas(
  [
    {
      cid: 'ntc1',
      type: 'ntc',
      tag: 'wokwi-ntc-temperature-sensor',
      x: 340,
      y: 140,
      rot: 0,
      flip: false,
      props: {},
    },
  ],
  [
    wire('w-ntc-sig', 'ntc1', 'OUT', BOARD_CID, 'A0'),
    wire('w-ntc-vcc', 'ntc1', 'VCC', BOARD_CID, '5V'),
    wire('w-ntc-gnd', 'ntc1', 'GND', BOARD_CID, 'GND.1'),
  ],
);
