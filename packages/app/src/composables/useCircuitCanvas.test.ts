import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { useCircuitCanvas, computeFitZoom } from './useCircuitCanvas';

describe('computeFitZoom (AUD-028 fit-to-container)', () => {
  it('fits content into the viewport, clamped to the zoom range', () => {
    // 2200×1520 content in a 1100×760 viewport → 0.5× before the 6% margin → ~0.47.
    expect(computeFitZoom(1100, 760, 2200, 1520, 0.4, 3)).toBeCloseTo(0.47, 2);
    // tiny content in a big viewport → would zoom way in, clamped to max.
    expect(computeFitZoom(2000, 2000, 100, 100, 0.4, 3)).toBe(3);
    // huge content → clamped to min (never below).
    expect(computeFitZoom(100, 100, 9000, 9000, 0.4, 3)).toBe(0.4);
    // limiting dimension is respected (wide viewport, tall content → height-bound).
    expect(computeFitZoom(4000, 380, 1100, 760, 0.4, 3)).toBeCloseTo((380 / 760) * 0.94, 2);
  });
  it('returns the minimum for a not-yet-laid-out viewport (never collapses to 0)', () => {
    expect(computeFitZoom(0, 0, 1100, 760, 0.4, 3)).toBe(0.4);
    expect(computeFitZoom(800, 600, 0, 0, 0.4, 3)).toBe(0.4);
  });
});

/** Canvas element stub; querySelector returns `el` for any cid (override per-test). */
function stubCanvas(el: unknown = null, width = 600, height = 340) {
  return {
    querySelector: () => el,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
    }),
    setPointerCapture: () => {},
  } as unknown as HTMLElement;
}

/**
 * Canvas stub whose querySelector returns a distinct fake wokwi element per cid (for net-trace tests).
 * A pin is either a bare name (empty signals) or `[name, signals]` to model GND/VCC/I2C roles.
 */
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

describe('useCircuitCanvas — model', () => {
  it('addPart appends with sequential cids, a staggered drop, and selects it', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    expect(c.addPart('led', 'wokwi-led')).toBe('led-1');
    expect(c.addPart('led', 'wokwi-led')).toBe('led-2');
    expect(c.placed.value).toHaveLength(2);
    expect(c.placed.value[1]!.y).toBeGreaterThan(c.placed.value[0]!.y);
    expect(c.selected.value).toBe('led-2'); // newest part is selected
    expect(c.placed.value[0]!.props.color).toBe('red'); // LEDs default to red
  });

  it('clickPin: first sets pending, same pin cancels, second distinct pin makes a wire', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    const led = c.addPart('led', 'wokwi-led');
    const res = c.addPart('resistor', 'wokwi-resistor');
    c.clickPin(led, 'A');
    expect(c.pendingPin.value).toEqual({ cid: led, pin: 'A' });
    c.clickPin(led, 'A'); // same → cancel
    expect(c.pendingPin.value).toBeNull();
    c.clickPin(led, 'A');
    c.clickPin(res, '1'); // second distinct → wire
    expect(c.wires.value).toHaveLength(1);
    expect(c.wires.value[0]).toMatchObject({
      from: { cid: led, pin: 'A' },
      to: { cid: res, pin: '1' },
      points: [],
    });
    expect(c.pendingPin.value).toBeNull();
  });

  it('clickPin starting a wire also selects the owning part (overlap is not a dead-end — UX risk #2)', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    const led = c.addPart('led', 'wokwi-led');
    c.selectPart(null);
    expect(c.selected.value).toBeNull();
    c.clickPin(led, 'A'); // a click meant as "select" that landed on a pin → wire starts AND part selects
    expect(c.pendingPin.value).toEqual({ cid: led, pin: 'A' });
    expect(c.selected.value).toBe(led); // inspector opens; Esc/cancelPending still cancels the wire
  });

  it('canvasDown drops a bend point while wiring; the committed wire keeps the bends', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    const led = c.addPart('led', 'wokwi-led');
    const res = c.addPart('resistor', 'wokwi-resistor');
    c.clickPin(led, 'A');
    c.canvasDown(120, 80);
    c.canvasDown(200, 80);
    expect(c.pendingPoints.value).toEqual([
      { x: 120, y: 80 },
      { x: 200, y: 80 },
    ]);
    c.clickPin(res, '1');
    expect(c.wires.value[0]!.points).toEqual([
      { x: 120, y: 80 },
      { x: 200, y: 80 },
    ]);
    expect(c.pendingPoints.value).toEqual([]); // reset after commit
  });

  it('canvasDown with no pending wire deselects the part', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    c.addPart('led', 'wokwi-led');
    expect(c.selected.value).toBe('led-1');
    c.canvasDown(10, 10);
    expect(c.selected.value).toBeNull();
  });

  it('removeWire / clearWires / wireCount', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    const led = c.addPart('led', 'wokwi-led');
    const res = c.addPart('resistor', 'wokwi-resistor');
    c.clickPin(led, 'A');
    c.clickPin(res, '1');
    c.clickPin(led, 'C');
    c.clickPin(res, '2');
    expect(c.wireCount.value).toBe(2);
    c.removeWire(c.wires.value[0]!.id);
    expect(c.wireCount.value).toBe(1);
    c.clearWires();
    expect(c.wireCount.value).toBe(0);
  });

  it('removePart cascades its wires, clears a dangling pending, deselects, keeps others', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    const led = c.addPart('led', 'wokwi-led');
    const res = c.addPart('resistor', 'wokwi-resistor');
    c.clickPin(led, 'A');
    c.clickPin(res, '1'); // wire
    c.clickPin(led, 'C'); // pending on led
    c.selectPart(led);
    c.removePart(led);
    expect(c.placed.value.map((p) => p.cid)).toEqual([res]);
    expect(c.wires.value).toHaveLength(0);
    expect(c.pendingPin.value).toBeNull();
    expect(c.selected.value).toBeNull();
  });

  it('rotatePart steps 30° (wrapping) and flipPart toggles', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    const led = c.addPart('led', 'wokwi-led');
    c.rotatePart(led, 1);
    expect(c.placed.value[0]!.rot).toBe(30);
    c.rotatePart(led, -1);
    c.rotatePart(led, -1);
    expect(c.placed.value[0]!.rot).toBe(330); // wraps below 0
    expect(c.placed.value[0]!.flip).toBe(false);
    c.flipPart(led);
    expect(c.placed.value[0]!.flip).toBe(true);
  });

  it('setColor / cycleColor update the LED colour', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    const led = c.addPart('led', 'wokwi-led');
    c.setColor(led, 'green');
    expect(c.placed.value[0]!.props.color).toBe('green');
    c.cycleColor(led);
    expect(c.placed.value[0]!.props.color).toBe('blue'); // unified LED_COLORS order: green → blue
  });

  it('drag clamps the part within the canvas bounds', () => {
    const el = ref(stubCanvas(null, 600, 340));
    const c = useCircuitCanvas(el);
    c.addPart('led', 'wokwi-led');
    c.startDrag({ clientX: 0, clientY: 0, pointerId: 1 } as unknown as PointerEvent, 'led-1');
    c.onDrag({ clientX: 99999, clientY: 99999, pointerId: 1 } as unknown as PointerEvent);
    expect(c.placed.value[0]!.x).toBe(600 - 24);
    expect(c.placed.value[0]!.y).toBe(340 - 24);
    c.onDrag({ clientX: -99999, clientY: -99999, pointerId: 1 } as unknown as PointerEvent);
    expect(c.placed.value[0]!.x).toBe(0);
    expect(c.placed.value[0]!.y).toBe(0);
    c.endDrag();
  });

  it('pinDots/wirePaths are empty until pins are measured (no DOM)', () => {
    const c = useCircuitCanvas(ref(stubCanvas()));
    c.addPart('led', 'wokwi-led');
    c.clickPin('led-1', 'A');
    c.clickPin('led-1', 'C'); // a wire whose pins have no measured geometry
    expect(c.pinDots.value).toEqual([]);
    expect(c.wirePaths.value).toEqual([]); // dropped — no geometry
  });
});

describe('useCircuitCanvas — pin geometry (pinInfo pixels, transformed by rotate/flip)', () => {
  function fakeWokwi(pins = [{ name: 'A', x: 25, y: 42, signals: [] }], w = 0, h = 0) {
    return {
      pinInfo: pins,
      offsetWidth: w,
      offsetHeight: h,
      updateComplete: Promise.resolve(),
      addEventListener: () => {},
    };
  }

  it('places a pin at origin + pinInfo offset (no rotation)', async () => {
    const c = useCircuitCanvas(ref(stubCanvas(fakeWokwi())));
    const cid = c.addPart('led', 'wokwi-led'); // led-1, dropped at x = DROP_X(320), y = 60
    await c.refreshPin(cid);
    const dot = c.pinDots.value.find((d) => d.cid === cid && d.pin === 'A');
    expect(dot).toBeTruthy();
    expect(dot!.x).toBeCloseTo(320 + 25); // placed.x + pin.x
    expect(dot!.y).toBeCloseTo(c.placed.value[0]!.y + 42); // placed.y + pin.y
  });

  it('rotating 90° moves a horizontal pin onto the vertical axis (around the element centre)', async () => {
    // pin at local (40,20), box 40×40 → centre (20,20). 90° (= 3×30°) maps (rx,ry)=(20,0) → (0,20).
    const c = useCircuitCanvas(
      ref(stubCanvas(fakeWokwi([{ name: 'P', x: 40, y: 20, signals: [] }], 40, 40))),
    );
    const cid = c.addPart('resistor', 'wokwi-resistor');
    await c.refreshPin(cid);
    const o = c.placed.value[0]!;
    const before = c.pinDots.value.find((d) => d.pin === 'P')!;
    expect(before.x).toBeCloseTo(o.x + 40);
    expect(before.y).toBeCloseTo(o.y + 20);
    c.rotatePart(cid, 1);
    c.rotatePart(cid, 1);
    c.rotatePart(cid, 1); // 90°
    const after = c.pinDots.value.find((d) => d.pin === 'P')!;
    expect(after.x).toBeCloseTo(o.x + 20);
    expect(after.y).toBeCloseTo(o.y + 40);
  });

  it('flipping mirrors a pin horizontally around the element centre', async () => {
    // pin at local (10,20), box 40×40 → flip maps lx 10 → 30.
    const c = useCircuitCanvas(
      ref(stubCanvas(fakeWokwi([{ name: 'P', x: 10, y: 20, signals: [] }], 40, 40))),
    );
    const cid = c.addPart('resistor', 'wokwi-resistor');
    await c.refreshPin(cid);
    const o = c.placed.value[0]!;
    c.flipPart(cid);
    const after = c.pinDots.value.find((d) => d.pin === 'P')!;
    expect(after.x).toBeCloseTo(o.x + 30);
    expect(after.y).toBeCloseTo(o.y + 20);
  });

  it('wire colour follows the pin signal (GND → black) and hoverLabel resolves', async () => {
    const c = useCircuitCanvas(
      ref(
        stubCanvas(
          fakeWokwi(
            [
              { name: 'GND', x: 5, y: 5, signals: [] },
              { name: '13', x: 25, y: 5, signals: [] },
            ],
            40,
            20,
          ),
        ),
      ),
    );
    const cid = c.addPart('resistor', 'wokwi-resistor');
    await c.refreshPin(cid);
    c.clickPin(cid, 'GND');
    c.clickPin(cid, '13');
    expect(c.wirePaths.value[0]!.color).toBe('#3B3530'); // GND → black
    c.pinEnter(cid, '13');
    expect(c.hoverLabel.value).toMatchObject({ name: '13' });
    c.pinLeave();
    expect(c.hoverLabel.value).toBeNull();
  });
});

describe('useCircuitCanvas — net trace (resolvePin: which board pin/channel a wire reaches)', () => {
  async function wired() {
    const board = '__board__';
    const c = useCircuitCanvas(
      ref(
        multiStub({
          [board]: ['13', 'GND.1', 'A0', '5V'],
          'led-1': ['A', 'C'],
          'resistor-2': ['1', '2'],
        }),
      ),
    );
    const led = c.addPart('led', 'wokwi-led');
    const res = c.addPart('resistor', 'wokwi-resistor');
    await c.refreshAll();
    return { c, board, led, res };
  }

  it('resolves an LED anode through a series resistor to the driving digital pin', async () => {
    const { c, board, led, res } = await wired();
    c.clickPin(board, '13');
    c.clickPin(res, '1');
    c.clickPin(res, '2');
    c.clickPin(led, 'A');
    expect(c.resolvePin(led, 'A')).toEqual({ digital: 13 }); // raw, ≤1 resistor hop
    expect(c.resolvePin(led, 'C')).toBeNull(); // cathode unwired
  });

  it('resolves ESP32 DevKit "D2"/"TX0"/"VP" and C3 "GPIOn" via the board catalog (P1-1)', async () => {
    const dev = useCircuitCanvas(
      ref(multiStub({ __board__: ['D2', 'TX0', 'VP'], 'led-1': ['A', 'C'] })),
      ref('esp32-devkit'),
    );
    const led = dev.addPart('led', 'wokwi-led');
    await dev.refreshAll();
    dev.clickPin('__board__', 'D2');
    dev.clickPin(led, 'A');
    expect(dev.resolvePin(led, 'A')).toEqual({ digital: 2, analog: undefined });
    // TX0 → GPIO1 (digital), VP → GPIO36 ADC0 (analog-only) — canonical, not regex
    dev.clickPin('__board__', 'TX0');
    dev.clickPin(led, 'C');
    expect(dev.resolvePin(led, 'C')).toEqual({ digital: 1, analog: undefined });

    const c3 = useCircuitCanvas(
      ref(multiStub({ __board__: ['GPIO8'], 'led-1': ['A', 'C'] })),
      ref('esp32-c3-devkitm'),
    );
    const led3 = c3.addPart('led', 'wokwi-led');
    await c3.refreshAll();
    c3.clickPin('__board__', 'GPIO8');
    c3.clickPin(led3, 'A');
    expect(c3.resolvePin(led3, 'A')).toEqual({ digital: 8, analog: undefined });
  });
});

describe('useCircuitCanvas — electrical-topology truth (P1-2/3/4: power/return/polarity/bus)', () => {
  const GND: [string, unknown[]] = ['GND.1', [{ type: 'power', signal: 'GND' }]];
  const VCC: [string, unknown[]] = ['5V', [{ type: 'power', signal: 'VCC' }]];
  const SDA: [string, unknown[]] = [
    'A4',
    [
      { type: 'analog', channel: 4 },
      { type: 'i2c', signal: 'SDA' },
    ],
  ];
  const SCL: [string, unknown[]] = [
    'A5',
    [
      { type: 'analog', channel: 5 },
      { type: 'i2c', signal: 'SCL' },
    ],
  ];

  function make(extraBoardPins: PinSpec[], parts: Record<string, PinSpec[]>) {
    const c = useCircuitCanvas(
      ref(multiStub({ __board__: ['13', 'A0', GND, VCC, SDA, SCL, ...extraBoardPins], ...parts })),
    );
    return c;
  }

  it('LED: lights only with anode→pin AND cathode→GND; reversed or GND-less is inert with an issue', async () => {
    const c = make([], { 'led-1': ['A', 'C'] });
    const led = c.addPart('led', 'wokwi-led');
    await c.refreshAll();
    // anode→13 only, no GND → inert + issue
    c.clickPin('__board__', '13');
    c.clickPin(led, 'A');
    expect(c.controllingDigital(led)).toBeUndefined();
    expect(c.componentStatus(led).issues).toContain('Cathode chưa nối GND');
    // add cathode→GND → valid
    c.clickPin(led, 'C');
    c.clickPin('__board__', 'GND.1');
    expect(c.controllingDigital(led)).toBe(13);
    expect(c.componentStatus(led).ok).toBe(true);
  });

  it('LED reversed polarity (cathode→pin, anode→GND) is inert with a polarity issue', async () => {
    const c = make([], { 'led-1': ['A', 'C'] });
    const led = c.addPart('led', 'wokwi-led');
    await c.refreshAll();
    c.clickPin('__board__', '13');
    c.clickPin(led, 'C'); // cathode on the driven pin
    c.clickPin(led, 'A');
    c.clickPin('__board__', 'GND.1'); // anode on GND
    expect(c.controllingDigital(led)).toBeUndefined();
    expect(c.componentStatus(led).issues).toContain('LED đảo cực (anode/cathode ngược)');
  });

  it('analog sensor needs VCC + GND, not just the signal pin (P1-4)', async () => {
    const c = make([], { 'potentiometer-1': ['GND', 'SIG', 'VCC'] });
    const pot = c.addPart('potentiometer', 'wokwi-potentiometer');
    await c.refreshAll();
    c.clickPin(pot, 'SIG');
    c.clickPin('__board__', 'A0'); // wiper only
    expect(c.controllingAnalog(pot)).toBeUndefined();
    expect(c.componentStatus(pot).issues).toEqual(
      expect.arrayContaining(['Thiếu VCC', 'Thiếu GND']),
    );
    c.clickPin(pot, 'VCC');
    c.clickPin('__board__', '5V');
    c.clickPin(pot, 'GND');
    c.clickPin('__board__', 'GND.1');
    expect(c.controllingAnalog(pot)).toBe(0);
    expect(c.componentStatus(pot).ok).toBe(true);
  });

  it('I2C device needs SDA + SCL + VCC + GND to be valid (P1-3)', async () => {
    const c = make([], { 'lcd-i2c-1': ['GND', 'VCC', 'SDA', 'SCL'] });
    const lcd = c.addPart('lcd-i2c', 'wokwi-lcd1602');
    await c.refreshAll();
    c.clickPin(lcd, 'SDA');
    c.clickPin('__board__', 'A4'); // SDA only
    expect(c.componentStatus(lcd).ok).toBe(false);
    expect(c.componentStatus(lcd).issues).toEqual(
      expect.arrayContaining(['Thiếu SCL', 'Thiếu VCC', 'Thiếu GND']),
    );
    for (const [pin, bp] of [
      ['SCL', 'A5'],
      ['VCC', '5V'],
      ['GND', 'GND.1'],
    ] as const) {
      c.clickPin(lcd, pin);
      c.clickPin('__board__', bp);
    }
    expect(c.componentStatus(lcd).ok).toBe(true);
  });

  it('a board with no wokwi element (ESP32-C3) gets wireable pins from the catalog (P0-2)', async () => {
    // querySelector returns null for __board__ → the board is drawn + measured from BOARD_CATALOG
    const c = useCircuitCanvas(ref(multiStub({ 'led-1': ['A', 'C'] })), ref('esp32-c3-devkitm'));
    const led = c.addPart('led', 'wokwi-led');
    await c.refreshAll();
    expect(c.boardLayout.value).toMatchObject({ mcu: 'esp32c3' });
    const boardPins = c.pinDots.value.filter((d) => d.cid === '__board__').map((d) => d.pin);
    expect(boardPins).toEqual(expect.arrayContaining(['GPIO8', 'GND', '3V3']));
    // wiring an LED to GPIO8 + GND resolves to GPIO 8 (visual pins == logical pins)
    c.clickPin('__board__', 'GPIO8');
    c.clickPin(led, 'A');
    c.clickPin(led, 'C');
    c.clickPin('__board__', 'GND');
    expect(c.controllingDigital(led)).toBe(8);
  });

  it('button needs a GND return as well as the GPIO (P1-4)', async () => {
    const c = make([], { 'button-1': ['1.l', '2.l', '1.r', '2.r'] });
    const btn = c.addPart('button', 'wokwi-pushbutton');
    await c.refreshAll();
    c.clickPin(btn, '1.l');
    c.clickPin('__board__', '13'); // GPIO only
    expect(c.controllingDigital(btn)).toBeUndefined();
    c.clickPin(btn, '2.l');
    c.clickPin('__board__', 'GND.1');
    expect(c.controllingDigital(btn)).toBe(13);
  });
});

describe('useCircuitCanvas — direct breadboard insertion (plug parts into holes, no jumper)', () => {
  /** A canvas stub whose fake elements expose pins at explicit local pixel offsets (for snap geometry). */
  function posStub(byCid: Record<string, Array<{ name: string; x: number; y: number }>>) {
    const mk = (pins: Array<{ name: string; x: number; y: number }>) => ({
      pinInfo: pins.map((p) => ({ name: p.name, x: p.x, y: p.y, signals: [] })),
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
  const down = (x: number, y: number, cid: string, c: ReturnType<typeof useCircuitCanvas>) =>
    c.startDrag({ clientX: x, clientY: y, pointerId: 1 } as unknown as PointerEvent, cid);

  it('holes in the same breadboard column are one net — pins resolve through it with no jumper between them', async () => {
    const c = useCircuitCanvas(
      ref(
        multiStub({
          __board__: ['13', 'GND.1'],
          'led-1': ['A', 'C'],
          'breadboard-2': ['a5', 'c5', 'a7'],
        }),
      ),
    );
    const led = c.addPart('led', 'wokwi-led');
    const bb = c.addPart('breadboard', 'sparklab-breadboard');
    await c.refreshAll();
    // board pin 13 → hole a5 ; LED anode → hole c5 (SAME column Tcol5, no jumper between a5 and c5)
    c.clickPin('__board__', '13');
    c.clickPin(bb, 'a5');
    c.clickPin(led, 'A');
    c.clickPin(bb, 'c5');
    expect(c.resolvePin(led, 'A')?.digital).toBe(13); // the column ties a5 and c5 together
    // a hole in a DIFFERENT column stays isolated
    const c2 = useCircuitCanvas(
      ref(multiStub({ __board__: ['13'], 'led-1': ['A', 'C'], 'breadboard-2': ['a5', 'a7'] })),
    );
    const led2 = c2.addPart('led', 'wokwi-led');
    const bb2 = c2.addPart('breadboard', 'sparklab-breadboard');
    await c2.refreshAll();
    c2.clickPin('__board__', '13');
    c2.clickPin(bb2, 'a5');
    c2.clickPin(led2, 'A');
    c2.clickPin(bb2, 'a7'); // Tcol7 ≠ Tcol5
    expect(c2.resolvePin(led2, 'A')?.digital).toBeUndefined();
  });

  it('dropping a part with its legs over holes auto-plugs each pin (invisible snap wires)', async () => {
    const c = useCircuitCanvas(
      ref(
        posStub({
          'breadboard-1': [
            { name: 'a5', x: 100, y: 50 },
            { name: 'f5', x: 100, y: 90 }, // bottom half → a different column (Bcol5) from a5 (Tcol5)
            { name: 'a7', x: 140, y: 50 },
          ],
          'led-2': [
            { name: 'A', x: 0, y: 0 },
            { name: 'C', x: 0, y: 40 },
          ],
        }),
      ),
    );
    const bb = c.addPart('breadboard', 'sparklab-breadboard');
    const led = c.addPart('led', 'wokwi-led');
    await c.refreshAll();
    // seat the breadboard at the origin; hover the LED so A sits on a5 and C on f5
    Object.assign(c.placed.value.find((p) => p.cid === bb)!, { x: 0, y: 0 });
    Object.assign(c.placed.value.find((p) => p.cid === led)!, { x: 100, y: 50 });
    down(100, 50, led, c);
    c.endDrag(); // snap on drop
    const snaps = c.wires.value.filter((w) => w.snap);
    expect(snaps.map((w) => `${w.from.pin}->${w.to.pin}`).sort()).toEqual(['A->a5', 'C->f5']);
    expect(c.wireCount.value).toBe(0); // snap wires are not counted as jumpers…
    expect(c.wirePaths.value).toHaveLength(0); // …and are never drawn (the legs just sit in the holes)
  });

  it('lifting a plugged part unplugs it (snap wires removed on drag), then re-seats on drop', async () => {
    const c = useCircuitCanvas(
      ref(
        posStub({
          'breadboard-1': [{ name: 'a5', x: 100, y: 50 }],
          'led-2': [{ name: 'A', x: 0, y: 0 }],
        }),
      ),
    );
    const bb = c.addPart('breadboard', 'sparklab-breadboard');
    const led = c.addPart('led', 'wokwi-led');
    await c.refreshAll();
    Object.assign(c.placed.value.find((p) => p.cid === bb)!, { x: 0, y: 0 });
    Object.assign(c.placed.value.find((p) => p.cid === led)!, { x: 100, y: 50 });
    down(100, 50, led, c);
    c.endDrag();
    expect(c.wires.value.filter((w) => w.snap)).toHaveLength(1);
    down(100, 50, led, c); // picking it up un-seats the pins
    expect(c.wires.value.filter((w) => w.snap)).toHaveLength(0);
    c.endDrag(); // still over the hole → re-plugs
    expect(c.wires.value.filter((w) => w.snap)).toHaveLength(1);
  });

  it('a hand-drawn jumper to a hole is left alone (not double-connected by a later snap)', async () => {
    const c = useCircuitCanvas(
      ref(
        posStub({
          'breadboard-1': [{ name: 'a5', x: 100, y: 50 }],
          'led-2': [{ name: 'A', x: 0, y: 0 }],
        }),
      ),
    );
    const bb = c.addPart('breadboard', 'sparklab-breadboard');
    const led = c.addPart('led', 'wokwi-led');
    await c.refreshAll();
    Object.assign(c.placed.value.find((p) => p.cid === bb)!, { x: 0, y: 0 });
    Object.assign(c.placed.value.find((p) => p.cid === led)!, { x: 100, y: 50 });
    c.clickPin(led, 'A'); // hand-wire A → a5 first
    c.clickPin(bb, 'a5');
    down(100, 50, led, c);
    c.endDrag(); // A is already wired → snap must not add a second connection
    expect(c.wires.value.filter((w) => w.from.cid === led && w.from.pin === 'A')).toHaveLength(1);
    expect(c.wires.value.some((w) => w.snap)).toBe(false);
  });

  it('draws a conduction strip for each in-use column, marked live when it reaches a board signal pin', async () => {
    const c = useCircuitCanvas(
      ref(
        posStub({
          __board__: [{ name: '13', x: 5, y: 5 }],
          'led-1': [
            { name: 'A', x: 0, y: 0 },
            { name: 'C', x: 0, y: 0 },
          ],
          'breadboard-2': [
            { name: 'a5', x: 100, y: 40 },
            { name: 'c5', x: 100, y: 60 },
            { name: 'e5', x: 100, y: 80 }, // all Tcol5 (same column, same x)
            { name: 'a7', x: 120, y: 40 }, // Tcol7 — left unwired, must NOT get a strip
          ],
        }),
      ),
    );
    const led = c.addPart('led', 'wokwi-led');
    const bb = c.addPart('breadboard', 'sparklab-breadboard');
    await c.refreshAll();
    c.clickPin('__board__', '13');
    c.clickPin(bb, 'a5'); // board pin 13 → column 5
    c.clickPin(led, 'A');
    c.clickPin(bb, 'c5'); // LED anode → same column 5 (no jumper between a5 and c5)
    const strips = c.breadboardStrips.value;
    expect(strips).toHaveLength(1); // only column 5 is in use
    expect(strips[0]!.x1).toBe(strips[0]!.x2); // a vertical run down the column
    expect(strips[0]!.live).toBe(true); // the column reaches board pin 13
    // an isolated column (no path to a board pin) is drawn but not "live"
    const c2 = useCircuitCanvas(
      ref(
        posStub({
          'led-1': [
            { name: 'A', x: 0, y: 0 },
            { name: 'C', x: 0, y: 0 },
          ],
          'breadboard-2': [
            { name: 'a5', x: 100, y: 40 },
            { name: 'c5', x: 100, y: 60 },
          ],
        }),
      ),
    );
    const led2 = c2.addPart('led', 'wokwi-led');
    const bb2 = c2.addPart('breadboard', 'sparklab-breadboard');
    await c2.refreshAll();
    c2.clickPin(led2, 'A');
    c2.clickPin(bb2, 'a5');
    c2.clickPin(led2, 'C');
    c2.clickPin(bb2, 'c5');
    expect(c2.breadboardStrips.value).toHaveLength(1);
    expect(c2.breadboardStrips.value[0]!.live).toBe(false); // no board pin on this column
  });
});
