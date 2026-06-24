import type { CircuitHost, SimComponent } from './sdk.js';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Analog 2-axis joystick (e.g. KY-023): two potentiometers (VERT, HORZ) feeding ADC channels plus a
 * momentary push-button (SEL, active-low with the MCU pull-up). Axes rest at centre (0.5 → ~mid-scale).
 * The model drives the ADC voltages + the SEL line through the host seams, so analogRead/digitalRead in
 * firmware reflect the stick. `vref` is the board's ADC reference (Uno 5V default), so 0.5 reads ~mid.
 */
export class Joystick implements SimComponent {
  /** Horizontal axis, 0..1 (0.5 = centre). */
  x = 0.5;
  /** Vertical axis, 0..1 (0.5 = centre). */
  y = 0.5;
  pressed = false;
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly pins: { vert: number; horz: number; sel?: number },
    private readonly opts: { vref?: number } = {},
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.applyAxes();
    this.applyButton();
  }

  setVert(v: number): void {
    this.y = clamp01(v);
    this.applyAxes();
  }
  setHorz(v: number): void {
    this.x = clamp01(v);
    this.applyAxes();
  }
  press(): void {
    this.setPressed(true);
  }
  release(): void {
    this.setPressed(false);
  }
  setPressed(v: boolean): void {
    this.pressed = v;
    this.applyButton();
  }

  private applyAxes(): void {
    const vref = this.opts.vref ?? 5;
    this.host?.setAdcVolts(this.pins.vert, this.y * vref);
    this.host?.setAdcVolts(this.pins.horz, this.x * vref);
  }
  private applyButton(): void {
    if (this.pins.sel === undefined) return;
    this.host?.drivePin(this.pins.sel, this.pressed ? 'low' : 'high-z'); // active-low (INPUT_PULLUP)
  }
}
