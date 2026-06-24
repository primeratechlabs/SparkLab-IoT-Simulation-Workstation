import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * A generic analog sensor whose AOUT pin feeds an ADC channel (gas/MQ-2, flame, soil moisture, …). It
 * presents a 0..1 reading as a fraction of the reference voltage; the live stimulus slider overrides
 * it through the host's ADC seam (setAdcVolts). The actual physics (gas concentration → resistance →
 * voltage) is abstracted to a single 0..1 "level" the user drives — enough for the curriculum's
 * threshold/analogRead logic.
 */
export class AnalogSensor implements SimComponent {
  /** Current reading as a 0..1 fraction of Vref. */
  value = 0;
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly channel: number,
    private readonly opts: { value?: number; vref?: number } = {},
  ) {
    this.value = Math.max(0, Math.min(1, opts.value ?? 0));
  }

  attach(host: CircuitHost): void {
    this.host = host;
    this.apply();
  }

  /** Set the reading (0 = nothing, 1 = full scale) live; the firmware's analogRead reflects it. */
  setValue(v: number): void {
    this.value = Math.max(0, Math.min(1, v));
    this.apply();
  }

  private apply(): void {
    this.host?.setAdcVolts(this.channel, this.value * (this.opts.vref ?? 5));
  }
}
