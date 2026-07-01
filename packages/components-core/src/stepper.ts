import type { CircuitHost, SimComponent } from './sdk.js';

/** Coil pins of a bipolar stepper (A±, B±) as Uno pin numbers; undefined = unwired. */
export interface StepperPins {
  aPlus?: number;
  aMinus?: number;
  bPlus?: number;
  bMinus?: number;
}

// 8 half-step electrical directions → index; the coil vector (a,b) with a,b ∈ {-1,0,+1} maps to an angle
// 0/45/…/315°. Advancing the sequence by one index steps the rotor CW, retreating steps it CCW.
function phaseIndex(a: number, b: number): number {
  if (a > 0 && b === 0) return 0;
  if (a > 0 && b > 0) return 1;
  if (a === 0 && b > 0) return 2;
  if (a < 0 && b > 0) return 3;
  if (a < 0 && b === 0) return 4;
  if (a < 0 && b < 0) return 5;
  if (a === 0 && b < 0) return 6;
  return 7; // a>0 && b<0
}

/**
 * Bipolar stepper motor driven directly from four GPIOs (A+, A-, B+, B-) — the wokwi `stepper-motor`
 * pinout. It follows the energised coil vector: each time the firmware advances the drive sequence the
 * rotor takes one half-step (CW when the electrical phase increases, CCW when it decreases), so a `Stepper`
 * sketch or a raw 4-step/8-step loop turns the shaft the right way by the right amount. `angleDeg` is the
 * accumulated mechanical angle the wokwi element renders.
 */
export class StepperMotor implements SimComponent {
  /** Net half-steps taken (signed). */
  steps = 0;
  private prevPhase = -1;
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly pins: StepperPins,
    private readonly stepsPerRev = 2048, // 28BYJ-48 (half-step) default; NEMA-17 full-step = 200
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    for (const p of [this.pins.aPlus, this.pins.aMinus, this.pins.bPlus, this.pins.bMinus]) {
      if (p !== undefined) host.watchPin(p, () => this.update());
    }
    this.update();
  }

  private lvl(pin: number | undefined): number {
    if (pin === undefined || !this.host) return 0;
    if (this.host.pinIsReleased(pin)) return 0;
    return this.host.pinLevel(pin) === 'high' ? 1 : 0;
  }

  private update(): void {
    const a = this.lvl(this.pins.aPlus) - this.lvl(this.pins.aMinus); // +1 / 0 / -1
    const b = this.lvl(this.pins.bPlus) - this.lvl(this.pins.bMinus);
    if (a === 0 && b === 0) return; // all coils off → rotor holds position
    const phase = phaseIndex(a, b);
    if (this.prevPhase >= 0 && phase !== this.prevPhase) {
      const d = (phase - this.prevPhase + 8) % 8; // 1..7 forward distance around the ring
      this.steps += d <= 4 ? d : d - 8; // shortest signed path (CW +, CCW -)
    }
    this.prevPhase = phase;
  }

  /** Accumulated shaft angle in degrees (wrapped to [0,360)). One rev = 2×stepsPerRev half-steps. */
  get angleDeg(): number {
    const deg = (this.steps * 360) / (this.stepsPerRev * 2);
    return ((deg % 360) + 360) % 360;
  }
}

/**
 * Biaxial (dual) stepper — two independent bipolar coils (axis 1 = A1±/B1±, axis 2 = A2±/B2±), the wokwi
 * `biaxial-stepper` pinout used for plotters/CNC demos. Each axis is a {@link StepperMotor}.
 */
export class BiaxialStepper implements SimComponent {
  readonly axis1: StepperMotor;
  readonly axis2: StepperMotor;

  constructor(
    readonly id: string,
    pins1: StepperPins,
    pins2: StepperPins,
    stepsPerRev = 2048,
  ) {
    this.axis1 = new StepperMotor(`${id}:1`, pins1, stepsPerRev);
    this.axis2 = new StepperMotor(`${id}:2`, pins2, stepsPerRev);
  }

  attach(host: CircuitHost): void {
    this.axis1.attach(host);
    this.axis2.attach(host);
  }
}
