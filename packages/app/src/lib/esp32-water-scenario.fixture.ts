/**
 * A DELIBERATELY SPARSE ESP32 + water-level-sensor demo: the probe reads on an ADC pin, two LEDs warn on
 * low / high water. Power is distributed on the breadboard rails so the wire ROLES are exercised — every
 * ground lands on the `−` rail (charcoal wires), every VCC on the `+` rail (red), signals stay palette-
 * coloured. Few, well-spread wires so nothing overlaps — the point is a clean, legible layout.
 */
export interface FixturePart {
  cid: string;
  type: string;
  tag: string;
  x: number;
  y: number;
  rot: number;
  flip: boolean;
  props: Record<string, unknown>;
}
export interface FixtureWire {
  id: string;
  from: { cid: string; pin: string };
  to: { cid: string; pin: string };
  points: { x: number; y: number }[];
}

const B = '__board__';

export const WATER_SCENARIO_SKETCH = `#include <Arduino.h>
// ESP32 + analog water-level probe: warn LEDs on low / high water.
const int WATER=34, LED_LO=2, LED_HI=4;
void setup(){
  Serial.begin(115200);
  pinMode(LED_LO,OUTPUT); pinMode(LED_HI,OUTPUT);
}
void loop(){
  int raw = analogRead(WATER);
  int pct = map(raw, 0, 4095, 0, 100);
  digitalWrite(LED_LO, pct < 30 ? HIGH : LOW);   // low-water warning
  digitalWrite(LED_HI, pct > 70 ? HIGH : LOW);   // high-water warning
  Serial.printf("water=%d%%\\n", pct);
  delay(100);
}
`;

export function waterScenario(): { placed: FixturePart[]; wires: FixtureWire[] } {
  const placed: FixturePart[] = [
    { cid: 'breadboard-1', type: 'breadboard', tag: 'sparklab-breadboard', x: 360, y: 300, rot: 0, flip: false, props: {} },
    { cid: 'water-1', type: 'water-level', tag: 'sparklab-water-sensor', x: 470, y: 470, rot: 0, flip: false, props: { level: 55 } },
    { cid: 'led-lo', type: 'led', tag: 'wokwi-led', x: 440, y: 190, rot: 0, flip: false, props: { color: 'green' } },
    { cid: 'led-hi', type: 'led', tag: 'wokwi-led', x: 560, y: 190, rot: 0, flip: false, props: { color: 'red' } },
    { cid: 'resistor-lo', type: 'resistor', tag: 'wokwi-resistor', x: 440, y: 250, rot: 0, flip: false, props: { ohms: 220 } },
    { cid: 'resistor-hi', type: 'resistor', tag: 'wokwi-resistor', x: 560, y: 250, rot: 0, flip: false, props: { ohms: 220 } },
  ];
  let n = 0;
  const w = (fc: string, fp: string, tc: string, tp: string): FixtureWire => ({
    id: `w${++n}`,
    from: { cid: fc, pin: fp },
    to: { cid: tc, pin: tp },
    points: [],
  });
  const wires: FixtureWire[] = [
    // power rails: board VIN → top '+' rail (the K-0135 probe runs on 5V per its datasheet), GND → '−' rail
    w(B, 'VIN', 'breadboard-1', 'tp1'),
    w(B, 'GND.1', 'breadboard-1', 'tn1'),
    // water probe: signal → ADC pin, VCC → 5V '+' rail, GND → '−' rail
    w('water-1', 'SIG', B, 'D34'),
    w('water-1', 'VCC', 'breadboard-1', 'tp5'),
    w('water-1', 'GND', 'breadboard-1', 'tn5'),
    // low-water LED (green): anode+resistor share column 8, resistor → column 10, board D2 → column 10
    w('led-lo', 'A', 'breadboard-1', 'e8'),
    w('resistor-lo', '1', 'breadboard-1', 'd8'),
    w('resistor-lo', '2', 'breadboard-1', 'd10'),
    w(B, 'D2', 'breadboard-1', 'a10'),
    w('led-lo', 'C', 'breadboard-1', 'tn9'),
    // high-water LED (red): columns 16/18, board D4
    w('led-hi', 'A', 'breadboard-1', 'e16'),
    w('resistor-hi', '1', 'breadboard-1', 'd16'),
    w('resistor-hi', '2', 'breadboard-1', 'd18'),
    w(B, 'D4', 'breadboard-1', 'a18'),
    w('led-hi', 'C', 'breadboard-1', 'tn17'),
  ];
  return { placed, wires };
}
