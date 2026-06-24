/**
 * Wire colouring by pin signal — ported from the "Trình nối mạch" design: GND wires are black, power
 * (3V3/5V/VIN) wires are red, and signal wires cycle a palette so adjacent wires stay distinguishable.
 */
const PALETTE = ['#3FA36B', '#3E7BD6', '#E0A52E', '#C85A3A', '#7C5CD6', '#2D9C8F'];

export function wireColor(name1: string, name2: string, ix: number): string {
  if (name1.includes('GND') || name2.includes('GND')) return '#3B3530';
  if (/3V3|5V|VIN/.test(`${name1} ${name2}`)) return '#D7503B';
  return PALETTE[ix % PALETTE.length]!;
}
