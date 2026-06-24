import { solveResistiveNetwork, voltageToAdc } from '@sparklab/sim-kernel';
import type { CircuitHost, SimComponent } from './sdk.js';

/** Photoresistor (LDR) as the top leg of a divider feeding an ADC channel:
 *  VCC ─ LDR ─ wiper(ADC) ─ Rfixed ─ GND. Brighter light lowers the LDR resistance,
 *  so the wiper sits HIGHER. Resistance follows the usual power law
 *  Rldr(lux) = R10·(10/lux)^gamma (≈10kΩ at 10 lux), solved by the DC nodal solver. */
export class Ldr implements SimComponent {
  /** R10: LDR resistance at the 10-lux reference point. */
  private static readonly R10_OHMS = 10_000;
  /** Slope of the log-log resistance curve (γ). */
  private static readonly GAMMA = 0.7;
  private static readonly LUX_MIN = 0.1;
  private static readonly LUX_MAX = 100_000;

  private host: CircuitHost | null = null;
  private lux = Ldr.LUX_MIN;
  /** Last wiper voltage set on the ADC channel (volts). */
  volts = 0;
  /** Last wiper voltage as a raw ADC reading (10-bit @ VCC ref). */
  adc = 0;
  constructor(
    readonly id: string,
    private readonly adcChannel: number,
    private readonly opts: { vcc?: number; rFixedOhms?: number } = {},
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.apply();
  }

  /** Set the incident illuminance in lux (clamped to a physical [0.1, 100000] range). */
  setLux(lux: number): void {
    this.lux = Math.max(Ldr.LUX_MIN, Math.min(Ldr.LUX_MAX, lux));
    this.apply();
  }

  private apply(): void {
    const vcc = this.opts.vcc ?? 5;
    const rFixed = this.opts.rFixedOhms ?? 10_000;
    const rLdr = Ldr.R10_OHMS * Math.pow(10 / this.lux, Ldr.GAMMA);
    const { W } = solveResistiveNetwork({
      fixed: { VCC: vcc, GND: 0 },
      resistors: [
        { a: 'VCC', b: 'W', ohms: rLdr || 1e-6 },
        { a: 'W', b: 'GND', ohms: rFixed || 1e-6 },
      ],
    });
    this.volts = W ?? 0;
    this.adc = voltageToAdc(this.volts, vcc);
    this.host?.setAdcVolts(this.adcChannel, this.volts);
  }
}
