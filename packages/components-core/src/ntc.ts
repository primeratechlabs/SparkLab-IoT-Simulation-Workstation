import { solveResistiveNetwork, voltageToAdc } from '@sparklab/sim-kernel';
import type { CircuitHost, SimComponent } from './sdk.js';

const KELVIN = 273.15; // 0°C in kelvin

/**
 * NTC thermistor in a voltage divider feeding an ADC channel:
 *   VCC ─ Rfixed ─ wiper(ADC) ─ NTC ─ GND.
 * The NTC resistance follows the Beta (β) equation
 *   R(T) = R0 · exp(B·(1/T − 1/T0))   with T, T0 in KELVIN,
 * so hotter ⇒ lower NTC resistance ⇒ lower wiper voltage (monotonic decreasing).
 * Defaults model a common 10kΩ@25°C / B=3950 part. The divider is solved by the DC
 * nodal solver, then converted to a raw ADC reading for inspection/tests.
 */
export class Ntc implements SimComponent {
  /** Last wiper voltage the component set on the ADC channel. */
  volts = 0;
  /** Last raw ADC reading (Uno default: 10-bit @ VCC ref) for the wiper voltage. */
  adcRaw = 0;
  private host: CircuitHost | null = null;
  private tempC = 25;
  private readonly vcc: number;
  private readonly rFixedOhms: number;
  private readonly beta: number;
  private readonly r0: number;

  constructor(
    readonly id: string,
    private readonly adcChannel: number,
    opts: { vcc?: number; rFixedOhms?: number; beta?: number; r0?: number } = {},
  ) {
    this.vcc = opts.vcc ?? 5;
    this.rFixedOhms = opts.rFixedOhms ?? 10_000;
    this.beta = opts.beta ?? 3950;
    this.r0 = opts.r0 ?? 10_000; // R0 at T0 = 25°C
  }

  attach(host: CircuitHost): void {
    this.host = host;
    this.apply();
  }

  /** Set the sensed temperature in °C (re-solves the divider). */
  setTempC(t: number): void {
    this.tempC = t;
    this.apply();
  }

  /** NTC resistance at the current temperature via the Beta equation (T in kelvin). */
  private resistanceOhms(): number {
    const t = this.tempC + KELVIN;
    const t0 = 25 + KELVIN; // T0 = 25°C
    return this.r0 * Math.exp(this.beta * (1 / t - 1 / t0));
  }

  private apply(): void {
    // VCC ─Rfixed─ W ─Rntc─ GND. Guard against a 0Ω short at extreme heat.
    const result = solveResistiveNetwork({
      fixed: { VCC: this.vcc, GND: 0 },
      resistors: [
        { a: 'VCC', b: 'W', ohms: this.rFixedOhms },
        { a: 'W', b: 'GND', ohms: this.resistanceOhms() || 1e-6 },
      ],
    });
    this.volts = result.W ?? 0;
    this.adcRaw = voltageToAdc(this.volts, this.vcc);
    this.host?.setAdcVolts(this.adcChannel, this.volts);
  }
}
