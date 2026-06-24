/**
 * Electrical Rule Checker — REFERENCE-SPEC Stage 3 §26. Static analysis of a circuit
 * netlist that flags wiring mistakes BEFORE/while simulating: power shorts, an LED
 * with no series resistor, I2C address conflicts, and floating inputs. Findings carry
 * a severity so the workbench can surface errors vs. warnings.
 *
 * This is a focused rule set (the gate set), not exhaustive analog DRC; more rules
 * (level mismatch, weak servo supply, overcurrent) layer on the same netlist model.
 */

export interface NetlistPin {
  component: string;
  pin: string;
}

export interface NetlistNet {
  id: string;
  pins: NetlistPin[];
}

export type ComponentKind =
  | 'mcu'
  | 'led'
  | 'rgb-led'
  | 'resistor'
  | 'button'
  | 'potentiometer'
  | 'ldr'
  | 'ntc'
  | 'buzzer'
  | 'relay'
  | 'servo'
  | 'ws2812'
  | 'i2c-device'
  | 'dht22'
  | 'hcsr04'
  | 'pir'
  | 'gas'
  | 'flame'
  | 'tilt'
  | 'switch'
  | 'sound'
  | 'pulse'
  | 'breadboard'
  | 'seg7'
  | 'joystick'
  | 'dipswitch'
  | 'ledbar'
  | 'encoder'
  | 'wire';

export interface NetlistComponent {
  id: string;
  kind: ComponentKind;
  /** I2C 7-bit address (for i2c-device). */
  address?: number;
  /** Resistance in ohms (for resistor / wire). */
  ohms?: number;
  /** MCU pin modes keyed by the pin name used in nets. */
  pinModes?: Record<string, 'output' | 'input' | 'input_pullup'>;
}

export interface Netlist {
  components: NetlistComponent[];
  nets: NetlistNet[];
  vccNet: string;
  gndNet: string;
}

export type ErcSeverity = 'error' | 'warning';
export interface ErcFinding {
  rule:
    | 'power-short'
    | 'led-no-resistor'
    | 'i2c-address-conflict'
    | 'i2c-no-bus'
    | 'floating-input'
    | 'over-voltage';
  severity: ErcSeverity;
  message: string;
  refs: string[]; // component/net ids involved
}

const SHORT_OHMS = 1; // ≤ this between VCC and GND counts as a short

export function runErc(netlist: Netlist): ErcFinding[] {
  const findings: ErcFinding[] = [];
  const byId = new Map(netlist.components.map((c) => [c.id, c]));
  const netOf = new Map<string, string>(); // "comp.pin" → net id
  for (const net of netlist.nets) {
    for (const p of net.pins) netOf.set(`${p.component}.${p.pin}`, net.id);
  }
  const netsTouching = (compId: string): Set<string> => {
    const out = new Set<string>();
    for (const net of netlist.nets) {
      if (net.pins.some((p) => p.component === compId)) out.add(net.id);
    }
    return out;
  };

  // 1. Power short: a low-ohm component bridging VCC and GND, or the two being merged.
  if (netlist.vccNet === netlist.gndNet) {
    findings.push({
      rule: 'power-short',
      severity: 'error',
      message: 'VCC and GND are the same net',
      refs: [netlist.vccNet],
    });
  }
  for (const c of netlist.components) {
    if ((c.kind === 'resistor' || c.kind === 'wire') && (c.ohms ?? 0) <= SHORT_OHMS) {
      const nets = netsTouching(c.id);
      if (nets.has(netlist.vccNet) && nets.has(netlist.gndNet)) {
        findings.push({
          rule: 'power-short',
          severity: 'error',
          message: `${c.id} shorts VCC to GND (${c.ohms ?? 0}Ω)`,
          refs: [c.id],
        });
      }
    }
  }

  // 2. LED without a series resistor: a resistor only counts if it is actually IN SERIES — it must
  //    touch an LED net AND bridge to a different net (≥2 distinct nets). A resistor with a floating
  //    leg (only one net) or both legs shorted onto the LED net does not limit current. (R5)
  for (const led of netlist.components.filter((c) => c.kind === 'led')) {
    const ledNets = netsTouching(led.id);
    // An LED only over-currents when it is actually IN a circuit — both legs on DISTINCT nets, forming a
    // current path. A floating LED (no nets) or a half-wired one (a single net, one leg dangling) carries
    // no current, so it must not be flagged — and so must not block the whole simulation from running.
    if (ledNets.size < 2) continue;
    const hasSeriesResistor = netlist.components.some((c) => {
      if (c.kind !== 'resistor') return false;
      const rNets = netsTouching(c.id);
      return rNets.size >= 2 && [...rNets].some((n) => ledNets.has(n));
    });
    if (!hasSeriesResistor) {
      findings.push({
        rule: 'led-no-resistor',
        severity: 'error',
        message: `${led.id} has no series resistor (will over-current)`,
        refs: [led.id],
      });
    }
  }

  // 3. I2C address conflict — a real bus needs BOTH lines: a device is "on a bus" only when its SDA
  //    AND its SCL pins are wired, and two devices share a bus only when they share the SAME sda net
  //    AND the SAME scl net. Sharing only one line is not a shared bus → no conflict; a device missing
  //    either line gets a missing-bus warning, not a conflict. (P2-1 + R4)
  const I2C_SEP = String.fromCharCode(0);
  const i2cDevices = netlist.components.filter((c) => c.kind === 'i2c-device');
  const busKeyOf = (id: string): string | null => {
    const sda = netOf.get(`${id}.sda`);
    const scl = netOf.get(`${id}.scl`);
    return sda && scl ? `${sda}${I2C_SEP}${scl}` : null;
  };
  const byBusAddr = new Map<string, { addr: number; ids: string[] }>();
  for (const d of i2cDevices) {
    const bus = busKeyOf(d.id);
    if (!bus) {
      findings.push({
        rule: 'i2c-no-bus',
        severity: 'warning',
        message: `${d.id} is not on a complete I2C bus (needs SDA + SCL)`,
        refs: [d.id],
      });
      continue;
    }
    if (d.address == null) continue;
    const key = `${bus}${I2C_SEP}${d.address}`;
    const group = byBusAddr.get(key) ?? { addr: d.address, ids: [] };
    group.ids.push(d.id);
    byBusAddr.set(key, group);
  }
  for (const { addr, ids } of byBusAddr.values()) {
    if (ids.length > 1) {
      findings.push({
        rule: 'i2c-address-conflict',
        severity: 'error',
        message: `I2C address 0x${addr.toString(16)} used by ${ids.join(', ')} on the same bus`,
        refs: ids,
      });
    }
  }

  // 4. Floating input: an MCU pin in mode 'input' (no pull-up) on a net with nothing
  //    driving it (no output pin, no pull-up component, not VCC/GND).
  for (const mcu of netlist.components.filter((c) => c.kind === 'mcu')) {
    for (const [pin, mode] of Object.entries(mcu.pinModes ?? {})) {
      if (mode !== 'input') continue;
      const netId = netOf.get(`${mcu.id}.${pin}`);
      if (!netId || netId === netlist.vccNet || netId === netlist.gndNet) continue;
      const net = netlist.nets.find((n) => n.id === netId)!;
      const driven = net.pins.some((p) => {
        const c = byId.get(p.component);
        if (!c) return false;
        // An MCU output drives the net; any non-MCU component (button to GND, pull
        // resistor, sensor) also provides a path, so only a bare MCU input floats.
        return c.kind === 'mcu' ? c.pinModes?.[p.pin] === 'output' : true;
      });
      if (!driven) {
        findings.push({
          rule: 'floating-input',
          severity: 'warning',
          message: `${mcu.id}.${pin} is a floating input (no driver or pull resistor)`,
          refs: [mcu.id, netId],
        });
      }
    }
  }

  return findings;
}
