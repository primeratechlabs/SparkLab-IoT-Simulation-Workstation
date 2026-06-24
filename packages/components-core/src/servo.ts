import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * SG90 hobby servo on a single signal pin, driven by the Arduino `Servo` library's
 * 50Hz pulse train. The angle is encoded in the HIGH pulse *width*, not the duty cycle:
 * the library holds the line HIGH for 1000–2000µs every 20ms, and the servo decodes
 * that width into a shaft position. We recover it the same way the hardware does —
 * timestamp the rising edge (low→high) with `host.now()`, then on the falling edge
 * (high→low) the width is `host.now() - rise`. Width maps linearly: 1000µs→0°,
 * 1500µs→90°, 2000µs→180° (clamped to 0..180; out-of-band pulses saturate at an end).
 */
export class ServoSg90 implements SimComponent {
  /** Last measured shaft angle in degrees (0..180); -1 until the first full pulse. */
  angleDeg = -1;
  /** Number of complete HIGH pulses measured — handy for tests / UI. */
  pulses = 0;
  private host: CircuitHost | null = null;
  private level: 'low' | 'high' | null = null;
  private riseNs = -1; // host time of the current pulse's rising edge, -1 if not HIGH

  constructor(
    readonly id: string,
    private readonly pin: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.level = host.pinLevel(this.pin);
    // If we attach mid-pulse (already HIGH) seed the rise time so the next falling
    // edge still yields a (slightly short) width rather than being dropped.
    if (this.level === 'high') this.riseNs = host.now();
    host.watchPin(this.pin, (level) => {
      if (level === this.level) return; // only real transitions matter
      this.level = level;
      const now = host.now();
      if (level === 'high') {
        // Rising edge: start timing this pulse.
        this.riseNs = now;
      } else if (this.riseNs >= 0) {
        // Falling edge: the pulse width decodes the commanded angle.
        const widthNs = now - this.riseNs;
        this.angleDeg = widthToAngle(widthNs);
        this.pulses++;
        this.riseNs = -1;
      }
    });
  }
}

/** Map a HIGH pulse width (ns) to a shaft angle in degrees, clamped to 0..180.
 *  1000µs→0°, 1500µs→90°, 2000µs→180° — i.e. 90° per 500µs above the 1000µs floor. */
function widthToAngle(widthNs: number): number {
  const widthUs = widthNs / 1000;
  const deg = ((widthUs - 1000) / 1000) * 180;
  return Math.max(0, Math.min(180, deg));
}
