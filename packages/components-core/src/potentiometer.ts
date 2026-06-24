import { potentiometerWiperVolts } from '@sparklab/sim-kernel';
import type { CircuitHost, SimComponent } from './sdk.js';

/** Rotary potentiometer as a voltage divider feeding an ADC channel. Position 0..1
 *  maps to 0..VCC at the wiper (solved by the DC nodal solver). */
export class Potentiometer implements SimComponent {
  private host: CircuitHost | null = null;
  private position = 0;
  constructor(
    readonly id: string,
    private readonly adcChannel: number,
    private readonly opts: { vcc?: number; ohms?: number } = {},
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.apply();
  }

  /** Set the wiper position (0 = GND end, 1 = VCC end). */
  setPosition(p: number): void {
    this.position = Math.max(0, Math.min(1, p));
    this.apply();
  }

  private apply(): void {
    const volts = potentiometerWiperVolts(
      this.opts.vcc ?? 5,
      this.opts.ohms ?? 10_000,
      this.position,
    );
    this.host?.setAdcVolts(this.adcChannel, volts);
  }
}
