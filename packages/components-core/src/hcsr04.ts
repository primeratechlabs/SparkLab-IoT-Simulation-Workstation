import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * HC-SR04 ultrasonic range finder — REFERENCE-SPEC Stage 3 timing device (I3). The
 * MCU sends a ≥10µs HIGH pulse on TRIG; the sensor then drives ECHO HIGH for a
 * duration proportional to distance (≈ 58µs per cm round-trip). On virtual time so
 * `pulseIn` reads the same width regardless of wall speed (gate #2).
 */
export class HcSr04 implements SimComponent {
  /** Distance to the target in centimetres (settable to simulate motion). */
  distanceCm = 20;
  pulses = 0;
  private host: CircuitHost | null = null;
  private prevTrig: 'low' | 'high' = 'low';
  private echoing = false;

  constructor(
    readonly id: string,
    private readonly trigPin: number,
    private readonly echoPin: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    host.drivePin(this.echoPin, 'low');
    host.watchPin(this.trigPin, (level) => {
      // Fire on the rising edge of TRIG (once per pulse, ignore re-entrancy).
      if (this.prevTrig === 'low' && level === 'high' && !this.echoing) this.fireEcho();
      this.prevTrig = level;
    });
  }

  private fireEcho(): void {
    const host = this.host;
    if (!host) return;
    this.echoing = true;
    this.pulses++;
    const echoUs = Math.max(1, Math.round(this.distanceCm * 58)); // round-trip time
    host.schedule(250_000, () => {
      // ~250µs after trigger the sensor raises ECHO
      host.drivePin(this.echoPin, 'high');
      host.schedule(echoUs * 1000, () => {
        host.drivePin(this.echoPin, 'low');
        this.echoing = false;
      });
    });
  }
}
