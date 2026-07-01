/**
 * The full ESP32 breadboard demo scenario (13 placed parts) as canvas data, shared by the node
 * instantiation test and the in-browser screenshot run. Power is distributed on the breadboard rails
 * (top + = 5V from VIN, top - = GND), so HC-SR04 / servos / LDR reach power+ground THROUGH the rails —
 * exactly the "does it still read through the breadboard rail" path we want to prove. LED anodes hop a
 * series resistor across two columns to their MCU pin; LED cathodes + button + sensor grounds land on the
 * `-` rail. Signals (TRIG/ECHO, servo PWM, button, LDR) jumper straight to the board GPIOs.
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

export const FULL_SCENARIO_SKETCH = `#include <Arduino.h>
// ESP32 DevKit on a breadboard: 3 LEDs, 2 buttons, LDR, HC-SR04, 2 servos — power off the breadboard rails.
const int LED_R=2, LED_G=4, LED_B=5, BTN1=12, BTN2=14, LDR=34, TRIG=25, ECHO=26, SRV1=18, SRV2=19;
bool blink=false, mode=false;
int servoDuty(int deg){ int us=map(constrain(deg,0,180),0,180,500,2500); return (int)((long)us*65535L/20000L); }
long readDistanceCm(){
  digitalWrite(TRIG,LOW); delayMicroseconds(2);
  digitalWrite(TRIG,HIGH); delayMicroseconds(10); digitalWrite(TRIG,LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  return us/58;
}
void setup(){
  Serial.begin(115200);
  pinMode(LED_R,OUTPUT); pinMode(LED_G,OUTPUT); pinMode(LED_B,OUTPUT);
  pinMode(BTN1,INPUT_PULLUP); pinMode(BTN2,INPUT_PULLUP);
  pinMode(TRIG,OUTPUT); pinMode(ECHO,INPUT);
  ledcAttach(SRV1,50,16); ledcAttach(SRV2,50,16);
}
void loop(){
  if(digitalRead(BTN1)==LOW){ blink=!blink; delay(150); }
  if(digitalRead(BTN2)==LOW){ mode=!mode; delay(150); }
  int light = analogRead(LDR);
  long dist = readDistanceCm();
  digitalWrite(LED_R, blink?HIGH:LOW);
  digitalWrite(LED_G, mode?HIGH:LOW);
  digitalWrite(LED_B, (dist>0&&dist<15)?HIGH:LOW);
  ledcWrite(SRV1, servoDuty(map(constrain(dist,2,60),2,60,0,180)));
  ledcWrite(SRV2, servoDuty(map(light,0,4095,0,180)));
  Serial.printf("light=%d dist=%ld blink=%d mode=%d\\n", light, dist, blink, mode);
  delay(60);
}
`;

/** Build {placed, wires}. Layout is a clean left-to-right flow; wires carry orthogonal `points`. */
export function fullScenario(): { placed: FixturePart[]; wires: FixtureWire[] } {
  const placed: FixturePart[] = [
    { cid: 'breadboard-1', type: 'breadboard', tag: 'sparklab-breadboard', x: 360, y: 250, rot: 0, flip: false, props: {} },
    { cid: 'led-2', type: 'led', tag: 'wokwi-led', x: 430, y: 150, rot: 0, flip: false, props: { color: 'red' } },
    { cid: 'led-3', type: 'led', tag: 'wokwi-led', x: 510, y: 150, rot: 0, flip: false, props: { color: 'green' } },
    { cid: 'led-4', type: 'led', tag: 'wokwi-led', x: 590, y: 150, rot: 0, flip: false, props: { color: 'blue' } },
    { cid: 'resistor-5', type: 'resistor', tag: 'wokwi-resistor', x: 430, y: 210, rot: 0, flip: false, props: { ohms: 220 } },
    { cid: 'resistor-6', type: 'resistor', tag: 'wokwi-resistor', x: 510, y: 210, rot: 0, flip: false, props: { ohms: 220 } },
    { cid: 'resistor-7', type: 'resistor', tag: 'wokwi-resistor', x: 590, y: 210, rot: 0, flip: false, props: { ohms: 220 } },
    { cid: 'button-8', type: 'button', tag: 'wokwi-pushbutton', x: 690, y: 300, rot: 0, flip: false, props: {} },
    { cid: 'button-9', type: 'button', tag: 'wokwi-pushbutton', x: 690, y: 380, rot: 0, flip: false, props: {} },
    { cid: 'ldr-10', type: 'ldr', tag: 'wokwi-photoresistor-sensor', x: 470, y: 470, rot: 0, flip: false, props: { rFixedOhms: 10000 } },
    { cid: 'servo-11', type: 'servo', tag: 'wokwi-servo', x: 820, y: 150, rot: 0, flip: false, props: {} },
    { cid: 'servo-12', type: 'servo', tag: 'wokwi-servo', x: 820, y: 320, rot: 0, flip: false, props: {} },
    { cid: 'hcsr04-13', type: 'hcsr04', tag: 'wokwi-hc-sr04', x: 620, y: 470, rot: 0, flip: false, props: { distanceCm: 20 } },
  ];

  let n = 0;
  const w = (fc: string, fp: string, tc: string, tp: string, pts: { x: number; y: number }[] = []): FixtureWire => ({
    id: `w${++n}`,
    from: { cid: fc, pin: fp },
    to: { cid: tc, pin: tp },
    points: pts,
  });

  const wires: FixtureWire[] = [
    // ── power rails: board VIN → top '+' rail (5V), board GND → top '-' rail (common ground) ──
    w(B, 'VIN', 'breadboard-1', 'tp1'),
    w(B, 'GND.1', 'breadboard-1', 'tn1'),
    // ── LED red: anode+resistor share column 5, resistor→column 7, board D2→column 7; cathode→ '-' rail ──
    w('led-2', 'A', 'breadboard-1', 'e5'),
    w('resistor-5', '1', 'breadboard-1', 'd5'),
    w('resistor-5', '2', 'breadboard-1', 'd7'),
    w(B, 'D2', 'breadboard-1', 'a7'),
    w('led-2', 'C', 'breadboard-1', 'tn15'),
    // ── LED green: columns 9/11, board D4 ──
    w('led-3', 'A', 'breadboard-1', 'e9'),
    w('resistor-6', '1', 'breadboard-1', 'd9'),
    w('resistor-6', '2', 'breadboard-1', 'd11'),
    w(B, 'D4', 'breadboard-1', 'a11'),
    w('led-3', 'C', 'breadboard-1', 'tn17'),
    // ── LED blue: columns 13/15, board D5 ──
    w('led-4', 'A', 'breadboard-1', 'e13'),
    w('resistor-7', '1', 'breadboard-1', 'd13'),
    w('resistor-7', '2', 'breadboard-1', 'd15'),
    w(B, 'D5', 'breadboard-1', 'a15'),
    w('led-4', 'C', 'breadboard-1', 'tn19'),
    // ── buttons: signal leg → GPIO, other leg → '-' rail ──
    w('button-8', '1.l', B, 'D12'),
    w('button-8', '2.l', 'breadboard-1', 'tn11'),
    w('button-9', '1.l', B, 'D14'),
    w('button-9', '2.l', 'breadboard-1', 'tn13'),
    // ── LDR: signal → D34, VCC → board 3V3 (ADC divider wants 3.3V), GND → '-' rail ──
    w('ldr-10', 'AO', B, 'D34'),
    w('ldr-10', 'VCC', B, '3V3'),
    w('ldr-10', 'GND', 'breadboard-1', 'tn9'),
    // ── servos: PWM → GPIO, V+ → '+' rail (5V), GND → '-' rail ──
    w('servo-11', 'PWM', B, 'D18'),
    w('servo-11', 'V+', 'breadboard-1', 'tp5'),
    w('servo-11', 'GND', 'breadboard-1', 'tn5'),
    w('servo-12', 'PWM', B, 'D19'),
    w('servo-12', 'V+', 'breadboard-1', 'tp7'),
    w('servo-12', 'GND', 'breadboard-1', 'tn7'),
    // ── HC-SR04: TRIG/ECHO → GPIO, VCC → '+' rail (5V) THROUGH the breadboard, GND → '-' rail ──
    w('hcsr04-13', 'TRIG', B, 'D25'),
    w('hcsr04-13', 'ECHO', B, 'D26'),
    w('hcsr04-13', 'VCC', 'breadboard-1', 'tp3'),
    w('hcsr04-13', 'GND', 'breadboard-1', 'tn3'),
  ];
  return { placed, wires };
}
