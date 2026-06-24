import type { CircuitHost, SimComponent } from './sdk.js';

/** Virtual time between quadrature transitions (a deliberate, human-speed turn — easily sampled). */
export const ENCODER_STEP_NS = 1_000_000; // 1 ms
const STEP_NS = ENCODER_STEP_NS;

/**
 * Incremental rotary encoder (KY-040): two quadrature outputs CLK + DT plus a push-button SW. At a
 * detent both lines rest HIGH (released → the MCU pull-ups read HIGH). One click emits a full Gray-code
 * cycle: turning CW the CLK line leads (falls first while DT is still HIGH), turning CCW the DT line
 * leads — exactly the phase relationship firmware uses (read DT on CLK's falling edge: HIGH = CW,
 * LOW = CCW). Transitions are emitted over VIRTUAL time, so detection is wall-speed independent (I3).
 */
export class RotaryEncoder implements SimComponent {
  /** Net detents turned (CW positive). */
  position = 0;
  pressed = false;
  /** Current logical line levels (true = driven LOW; false = released/HIGH), for reflection/tests. */
  clkLow = false;
  dtLow = false;
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly pins: { clk: number; dt: number; sw?: number },
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    // detent rest: both quadrature lines + the button released (the MCU pull-ups read HIGH).
    this.driveClk(false);
    this.driveDt(false);
    if (this.pins.sw !== undefined) host.drivePin(this.pins.sw, 'high-z');
  }

  press(): void {
    this.setPressed(true);
  }
  release(): void {
    this.setPressed(false);
  }
  setPressed(v: boolean): void {
    this.pressed = v;
    if (this.pins.sw !== undefined) this.host?.drivePin(this.pins.sw, v ? 'low' : 'high-z');
  }

  /** Turn `detents` clicks: positive = clockwise, negative = counter-clockwise. */
  turn(detents: number): void {
    // Whole detents only — a fractional command (e.g. a 2.5 from a slider, or a fractional delta) is
    // truncated toward zero so it can never emit a spurious extra Gray cycle.
    const n = Math.trunc(detents);
    if (!this.host || n === 0) return;
    const dir = Math.sign(n);
    const cw = dir > 0;
    // The COMMANDED position updates SYNCHRONOUSLY (the quadrature SIGNALS still emit over virtual time
    // below). This keeps a delta-set like applyProp('position', v) → turn(v - position) correct even when
    // the UI fires several edits before virtual time advances — otherwise position reads stale and double-counts.
    this.position += n;
    let t = 0;
    for (let k = 0; k < Math.abs(n); k++) {
      // CW: CLK leads (falls first); CCW: DT leads. Each is a full 4-edge Gray cycle back to rest.
      const seq: Array<['clk' | 'dt', boolean]> = cw
        ? [
            ['clk', true],
            ['dt', true],
            ['clk', false],
            ['dt', false],
          ]
        : [
            ['dt', true],
            ['clk', true],
            ['dt', false],
            ['clk', false],
          ];
      for (const [line, low] of seq) {
        t += STEP_NS;
        this.host.schedule(t, () => (line === 'clk' ? this.driveClk(low) : this.driveDt(low)));
      }
    }
  }

  private driveClk(low: boolean): void {
    this.clkLow = low;
    this.host?.drivePin(this.pins.clk, low ? 'low' : 'high-z');
  }
  private driveDt(low: boolean): void {
    this.dtLow = low;
    this.host?.drivePin(this.pins.dt, low ? 'low' : 'high-z');
  }
}
