/**
 * Wire colouring by pin ROLE — ported from the "Trình nối mạch" design: GND wires are charcoal, power
 * (3V3/5V/VIN/VCC) wires are red, and signal wires cycle a palette so adjacent wires stay distinguishable.
 * Either endpoint deciding the role is enough (a signal→GND wire is a GND wire). Beyond the raw pin name
 * this also reads the breadboard RAIL a wire lands on — the `−` rails (tn/bn) are ground, the `+` rails
 * (tp/bp) are power — so a device whose VCC/GND is distributed through the breadboard rails (not a direct
 * board pin) still gets the right colour. Ground wins over power when a wire somehow touches both.
 */
const PALETTE = ['#3FA36B', '#3E7BD6', '#E0A52E', '#C85A3A', '#7C5CD6', '#2D9C8F'];
const GND = /GND/i; // board GND / component gnd / wokwi GND pin
const GND_RAIL = /^(tn|bn)\d+$/; // breadboard − rails (Trail−/Brail−)
const PWR = /3V3|5V|VIN|VCC|V\+/i; // board 3V3/5V/VIN / component vcc / servo V+
const PWR_RAIL = /^(tp|bp)\d+$/; // breadboard + rails (Trail+/Brail+)

const isGnd = (n: string): boolean => GND.test(n) || GND_RAIL.test(n);
const isPwr = (n: string): boolean => PWR.test(n) || PWR_RAIL.test(n);

export function wireColor(name1: string, name2: string, ix: number): string {
  if (isGnd(name1) || isGnd(name2)) return '#3B3530';
  if (isPwr(name1) || isPwr(name2)) return '#D7503B';
  return PALETTE[ix % PALETTE.length]!;
}
