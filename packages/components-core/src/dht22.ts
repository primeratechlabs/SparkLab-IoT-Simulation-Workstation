import type { CircuitHost, SimComponent } from './sdk.js';

interface Segment {
  until: number; // ns from trigger
  high: boolean;
}

/**
 * DHT22 temperature/humidity sensor — single-wire timing protocol (invariant I3).
 * After the MCU's start pulse (drive LOW ≥1ms, then release), the sensor replies with
 * a precisely-timed bit stream the MCU decodes: 80µs LOW + 80µs HIGH, then 40 data
 * bits (50µs LOW + {26µs='0', 70µs='1'} HIGH), humidity·10, temp·10, checksum. Driven
 * on virtual time so the result is wall-speed independent (gate #2).
 */
export class Dht22 implements SimComponent {
  triggers = 0;
  private host: CircuitHost | null = null;
  private segments: Segment[] = [];
  private tempC: number;
  private humidity: number;
  private responding = false;
  private prevDrivingLow = false;

  constructor(
    readonly id: string,
    private readonly pin: number,
    opts: { tempC?: number; humidity?: number } = {},
  ) {
    this.tempC = opts.tempC ?? 24.0;
    this.humidity = opts.humidity ?? 55.0;
    this.rebuildWaveform();
  }

  /** Live inspector stimulus: update the reading the sensor reports on the NEXT read (no rebuild). */
  setReading(opts: { tempC?: number; humidity?: number }): void {
    if (opts.tempC !== undefined) this.tempC = opts.tempC;
    if (opts.humidity !== undefined) this.humidity = opts.humidity;
    this.rebuildWaveform();
  }

  /** Encode the current temp/humidity into the single-wire bit-timing waveform (humidity·10, temp·10). */
  private rebuildWaveform(): void {
    const hum = Math.round(this.humidity * 10);
    const temp = Math.round(this.tempC * 10);
    const bytes = [(hum >> 8) & 0xff, hum & 0xff, (temp >> 8) & 0xff, temp & 0xff];
    bytes.push(bytes.reduce((a, b) => (a + b) & 0xff, 0)); // checksum
    const us: { dur: number; high: boolean }[] = [
      { dur: 40, high: true }, // line idles high during the MCU pull-up delay
      { dur: 80, high: false }, // DHT response: 80µs LOW
      { dur: 80, high: true }, //               80µs HIGH
    ];
    for (const b of bytes) {
      for (let bit = 7; bit >= 0; bit--) {
        us.push({ dur: 50, high: false });
        us.push({ dur: (b >> bit) & 1 ? 70 : 26, high: true });
      }
    }
    us.push({ dur: 50, high: false }); // end-of-transmission LOW — the falling edge that
    // terminates the MCU's expectPulse(HIGH) on the 40th (last) bit.
    us.push({ dur: 200, high: true }); // then release (idle high)
    let t = 0;
    this.segments = us.map((s) => ({ until: (t += s.dur * 1000), high: s.high }));
  }

  attach(host: CircuitHost): void {
    this.host = host;
    // The data line idles HIGH (the MCU's pull-up / the sensor's open-drain release).
    // The emulator models an input pin purely from its external value, so we must
    // present that HIGH idle explicitly — otherwise the line reads LOW when undriven.
    host.drivePin(this.pin, 'high-z');
  }

  /**
   * Per-instruction hook used ONLY to detect the MCU's start pulse (drive LOW →
   * release). The reply itself is scheduled on the kernel at exact virtual times
   * (not tick-polled), so the 26µs/70µs bit widths are precise enough for the DHT
   * library's cycle-count threshold to decode correctly.
   */
  tick(): void {
    const host = this.host;
    if (!host || this.responding) return;
    const released = host.pinIsReleased(this.pin);
    const drivingLow = !released && host.pinLevel(this.pin) === 'low';
    if (this.prevDrivingLow && released) this.startReply(host);
    this.prevDrivingLow = drivingLow;
  }

  private startReply(host: CircuitHost): void {
    this.responding = true;
    this.triggers++;
    // Each segment's level is applied at its START time (the previous segment's end),
    // so the level holds for the whole segment. (Scheduling at `until` would shift the
    // whole waveform by one segment and corrupt the bit timing.)
    let start = 0;
    for (const seg of this.segments) {
      const level = seg.high ? 'high' : 'low';
      host.schedule(start, () => host.drivePin(this.pin, level));
      start = seg.until;
    }
    host.schedule(start, () => {
      host.drivePin(this.pin, 'high-z'); // release the line; ready for the next read
      this.responding = false;
      this.prevDrivingLow = false;
    });
  }
}
