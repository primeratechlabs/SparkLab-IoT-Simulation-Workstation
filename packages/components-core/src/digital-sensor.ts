import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * A generic digital sensor whose OUT pin the MCU reads (PIR motion, tilt switch, reed, …). It drives
 * its signal pin HIGH while "active" (motion present / tilted) and LOW otherwise — a scene parameter
 * the user toggles to exercise the sketch. Stateless w.r.t. time (level follows `active` directly).
 */
export class DigitalSensor implements SimComponent {
  /** True → the sensor asserts its OUT line (the firmware's digitalRead sees HIGH). */
  active = false;
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly pin: number,
    opts: { active?: boolean } = {},
  ) {
    this.active = opts.active ?? false;
  }

  attach(host: CircuitHost): void {
    this.host = host;
    this.apply();
  }

  /** Toggle the sensor (e.g. motion detected) live; the firmware reads the new level immediately. */
  setActive(v: boolean): void {
    this.active = v;
    this.apply();
  }

  private apply(): void {
    this.host?.drivePin(this.pin, this.active ? 'high' : 'low');
  }
}
