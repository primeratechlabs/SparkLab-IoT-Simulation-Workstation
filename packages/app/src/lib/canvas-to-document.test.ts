import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { componentReadiness, NetGraph, MCU_REF } from '@sparklab/schematic';
import { useCircuitCanvas } from '../composables/useCircuitCanvas';
import { canvasToDocument, projectCanvas, aliasBoardPin } from './canvas-to-document';
import { BOARD_CID, type Placed, type CanvasWire } from '../composables/useCircuitCanvas';

type PinSpec = string | [string, unknown[]];
function multiStub(byCid: Record<string, PinSpec[]>) {
  const mk = (pins: PinSpec[]) => ({
    pinInfo: pins.map((p) => {
      const [name, signals] = Array.isArray(p) ? p : [p, []];
      return { name, x: 0, y: 0, signals };
    }),
    offsetWidth: 0,
    offsetHeight: 0,
    updateComplete: Promise.resolve(),
    addEventListener: () => {},
  });
  return {
    querySelector: (sel: string) => {
      const cid = /data-cid="([^"]+)"/.exec(sel)?.[1];
      return cid && byCid[cid] ? mk(byCid[cid]) : null;
    },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 340,
      right: 600,
      bottom: 340,
      x: 0,
      y: 0,
    }),
    setPointerCapture: () => {},
  } as unknown as HTMLElement;
}

// Uno header pins (with the signals the canvas reads for rail/bus roles).
const GND: [string, unknown[]] = ['GND.1', [{ type: 'power', signal: 'GND' }]];
const VCC: [string, unknown[]] = ['5V', [{ type: 'power', signal: 'VCC' }]];
const A0: [string, unknown[]] = ['A0', [{ type: 'analog', channel: 0 }]];
const A4: [string, unknown[]] = [
  'A4',
  [
    { type: 'analog', channel: 4 },
    { type: 'i2c', signal: 'SDA' },
  ],
];
const A5: [string, unknown[]] = [
  'A5',
  [
    { type: 'analog', channel: 5 },
    { type: 'i2c', signal: 'SCL' },
  ],
];

describe('canvasToDocument — bridge', () => {
  it('aliasBoardPin maps Uno bare numbers + GND.x + 3.3V to catalog names', () => {
    expect(aliasBoardPin('13')).toBe('D13');
    expect(aliasBoardPin('GND.2')).toBe('GND');
    expect(aliasBoardPin('3.3V')).toBe('3V3');
    expect(aliasBoardPin('A4')).toBe('A4');
    expect(aliasBoardPin('D2')).toBe('D2'); // ESP32 already prefixed
  });

  it('translates placed parts + wires into a CircuitDocument with catalog pin names', () => {
    const c = useCircuitCanvas(ref(multiStub({ __board__: ['13'], 'led-1': ['A', 'C'] })));
    const led = c.addPart('led', 'wokwi-led');
    c.clickPin('__board__', '13');
    c.clickPin(led, 'A');
    const doc = canvasToDocument(c.placed.value, c.wires.value, 'arduino-uno');
    expect(doc.components).toHaveLength(1);
    expect(doc.wires[0]).toMatchObject({
      from: { component: 'mcu', pin: 'D13' },
      to: { component: led, pin: 'anode' },
    });
  });

  it('projectCanvas REPORTS unmapped wire endpoints (AUD-003: structured error, no silent drop)', () => {
    const placed = [
      { cid: 'led-1', type: 'led', tag: 'wokwi-led', x: 0, y: 0, rot: 0, props: {} },
    ] as unknown as Placed[];
    const wires = [
      { id: 'w1', from: { cid: BOARD_CID, pin: '13' }, to: { cid: 'led-1', pin: 'A' } }, // both map
      { id: 'w2', from: { cid: BOARD_CID, pin: '13' }, to: { cid: 'led-1', pin: 'NOPE' } }, // pin not in catalog
      { id: 'w3', from: { cid: BOARD_CID, pin: '13' }, to: { cid: 'ghost', pin: 'X' } }, // unknown component
    ] as unknown as CanvasWire[];
    const { doc, unmapped } = projectCanvas(placed, wires, 'arduino-uno');
    expect(doc.wires.map((w) => w.id)).toEqual(['w1']); // ONLY the fully-mapped wire reaches the netlist
    expect(unmapped).toEqual([
      {
        wireId: 'w2',
        endpoint: 'to',
        cid: 'led-1',
        pin: 'NOPE',
        reason: 'pin-has-no-catalog-equivalent',
      },
      { wireId: 'w3', endpoint: 'to', cid: 'ghost', pin: 'X', reason: 'unknown-component' },
    ]);
  });

  it('breadboard: holes in the same column-half form one net (row-net, no explicit wire); other halves do not', () => {
    const placed = [
      {
        cid: 'bb-1',
        type: 'breadboard',
        tag: 'sparklab-breadboard',
        x: 0,
        y: 0,
        rot: 0,
        props: {},
      },
      { cid: 'led-1', type: 'led', tag: 'wokwi-led', x: 0, y: 0, rot: 0, props: {} },
    ] as unknown as Placed[];
    const wires = [
      { id: 'w1', from: { cid: BOARD_CID, pin: '13' }, to: { cid: 'bb-1', pin: 'a5' } }, // D13 → hole a5 (Tcol5)
      { id: 'w2', from: { cid: 'led-1', pin: 'A' }, to: { cid: 'bb-1', pin: 'c5' } }, // anode → hole c5 (Tcol5)
      { id: 'w3', from: { cid: 'led-1', pin: 'C' }, to: { cid: 'bb-1', pin: 'a6' } }, // cathode → hole a6 (Tcol6)
    ] as unknown as CanvasWire[];
    const { doc, unmapped } = projectCanvas(placed, wires, 'arduino-uno');
    expect(unmapped).toEqual([]); // every breadboard hole resolves (to its net group) — never unmapped
    // a5 and c5 both collapse to the SAME breadboard net node; a6 is a different column → different node.
    expect(doc.wires.find((w) => w.id === 'w1')!.to).toEqual({ component: 'bb-1', pin: 'Tcol5' });
    expect(doc.wires.find((w) => w.id === 'w2')!.to).toEqual({ component: 'bb-1', pin: 'Tcol5' });
    expect(doc.wires.find((w) => w.id === 'w3')!.to).toEqual({ component: 'bb-1', pin: 'Tcol6' });

    const g = new NetGraph(doc);
    // D13 and the LED anode are joined THROUGH the breadboard column (Tcol5) with no wire between them.
    const d13Net = g.netOf({ component: MCU_REF, pin: 'D13' });
    expect(d13Net).toContainEqual({ component: 'led-1', pin: 'anode' });
    expect(d13Net).not.toContainEqual({ component: 'led-1', pin: 'cathode' }); // cathode is on Tcol6
  });
});

describe('canvasToDocument — conformance lock (canvas verdict ⇔ engine componentReadiness)', () => {
  /** Assert the canvas topology verdict equals the engine's, via the bridge. */
  async function agree(
    byCid: Record<string, PinSpec[]>,
    type: string,
    tag: string,
    wire: (c: ReturnType<typeof useCircuitCanvas>, cid: string) => void,
  ) {
    const c = useCircuitCanvas(ref(multiStub(byCid)));
    const cid = c.addPart(type, tag);
    wire(c, cid); // may add a series resistor — measure AFTER so its pins exist
    await c.refreshAll();
    const canvasOk = c.componentStatus(cid).ok;
    const engineOk = componentReadiness(
      canvasToDocument(c.placed.value, c.wires.value, 'arduino-uno'),
    ).get(cid)!.ok;
    expect(engineOk).toBe(canvasOk); // no divergence between the two engines
    return canvasOk;
  }

  it('LED: complete circuit agrees true, GND-less agrees false', async () => {
    const board = { __board__: ['13', GND], 'led-1': ['A', 'C'], 'resistor-2': ['1', '2'] };
    const ok = await agree(board, 'led', 'wokwi-led', (c, cid) => {
      const res = c.addPart('resistor', 'wokwi-resistor');
      c.clickPin('__board__', '13');
      c.clickPin(res, '1');
      c.clickPin(res, '2');
      c.clickPin(cid, 'A');
      c.clickPin(cid, 'C');
      c.clickPin('__board__', 'GND.1');
    });
    expect(ok).toBe(true);

    const bad = await agree(
      { __board__: ['13'], 'led-1': ['A', 'C'] },
      'led',
      'wokwi-led',
      (c, cid) => {
        c.clickPin('__board__', '13');
        c.clickPin(cid, 'A'); // no cathode→GND
      },
    );
    expect(bad).toBe(false);
  });

  it('potentiometer: rails present agrees true, wiper-only agrees false', async () => {
    const full = await agree(
      { __board__: [A0, VCC, GND], 'potentiometer-1': ['GND', 'SIG', 'VCC'] },
      'potentiometer',
      'wokwi-potentiometer',
      (c, cid) => {
        c.clickPin(cid, 'SIG');
        c.clickPin('__board__', 'A0');
        c.clickPin(cid, 'VCC');
        c.clickPin('__board__', '5V');
        c.clickPin(cid, 'GND');
        c.clickPin('__board__', 'GND.1');
      },
    );
    expect(full).toBe(true);

    const partial = await agree(
      { __board__: [A0, VCC, GND], 'potentiometer-1': ['GND', 'SIG', 'VCC'] },
      'potentiometer',
      'wokwi-potentiometer',
      (c, cid) => {
        c.clickPin(cid, 'SIG');
        c.clickPin('__board__', 'A0');
      },
    );
    expect(partial).toBe(false);
  });

  it('I2C LCD: full bus agrees true, SDA-only agrees false', async () => {
    const full = await agree(
      { __board__: [A4, A5, VCC, GND], 'lcd-i2c-1': ['GND', 'VCC', 'SDA', 'SCL'] },
      'lcd-i2c',
      'wokwi-lcd1602',
      (c, cid) => {
        c.clickPin(cid, 'SDA');
        c.clickPin('__board__', 'A4');
        c.clickPin(cid, 'SCL');
        c.clickPin('__board__', 'A5');
        c.clickPin(cid, 'VCC');
        c.clickPin('__board__', '5V');
        c.clickPin(cid, 'GND');
        c.clickPin('__board__', 'GND.1');
      },
    );
    expect(full).toBe(true);

    const partial = await agree(
      { __board__: [A4, A5, VCC, GND], 'lcd-i2c-1': ['GND', 'VCC', 'SDA', 'SCL'] },
      'lcd-i2c',
      'wokwi-lcd1602',
      (c, cid) => {
        c.clickPin(cid, 'SDA');
        c.clickPin('__board__', 'A4');
      },
    );
    expect(partial).toBe(false);
  });

  it('relay (ks2e coil): COIL1→pin + COIL2→GND agrees true (R2)', async () => {
    const ok = await agree(
      {
        __board__: ['13', GND],
        'relay-1': ['NO2', 'NC2', 'P2', 'COIL2', 'NO1', 'NC1', 'P1', 'COIL1'],
      },
      'relay',
      'wokwi-ks2e-m-dc5',
      (c, cid) => {
        c.clickPin(cid, 'COIL1');
        c.clickPin('__board__', '13');
        c.clickPin(cid, 'COIL2');
        c.clickPin('__board__', 'GND.1');
      },
    );
    expect(ok).toBe(true);
  });

  it('WS2812: DIN→pin + VDD→5V + VSS→GND agrees true; DIN-only agrees false (R2)', async () => {
    const board = { __board__: ['13', VCC, GND], 'ws2812-1': ['VDD', 'DOUT', 'VSS', 'DIN'] };
    const full = await agree(board, 'ws2812', 'wokwi-neopixel', (c, cid) => {
      c.clickPin(cid, 'DIN');
      c.clickPin('__board__', '13');
      c.clickPin(cid, 'VDD');
      c.clickPin('__board__', '5V');
      c.clickPin(cid, 'VSS');
      c.clickPin('__board__', 'GND.1');
    });
    expect(full).toBe(true);
    const partial = await agree(board, 'ws2812', 'wokwi-neopixel', (c, cid) => {
      c.clickPin(cid, 'DIN');
      c.clickPin('__board__', '13');
    });
    expect(partial).toBe(false);
  });

  it('SSD1306 (SPI-bodied, I²C-wired): DATA→SDA + CLK→SCL + VIN→5V + GND agrees true (R2)', async () => {
    const ok = await agree(
      {
        __board__: [A4, A5, VCC, GND],
        'ssd1306-1': ['DATA', 'CLK', 'DC', 'RST', 'CS', '3V3', 'VIN', 'GND'],
      },
      'ssd1306',
      'wokwi-ssd1306',
      (c, cid) => {
        c.clickPin(cid, 'DATA');
        c.clickPin('__board__', 'A4');
        c.clickPin(cid, 'CLK');
        c.clickPin('__board__', 'A5');
        c.clickPin(cid, 'VIN');
        c.clickPin('__board__', '5V');
        c.clickPin(cid, 'GND');
        c.clickPin('__board__', 'GND.1');
      },
    );
    expect(ok).toBe(true);
  });
});
