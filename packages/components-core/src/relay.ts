import type { CircuitHost, SimComponent } from './sdk.js';

/** Which throw the common (COM) contact is connected to. */
export type RelayPosition = 'NO' | 'NC';

/**
 * Single-pole (SPDT) relay driven by a control GPIO through a transistor. Watches the
 * control pin; the coil energizes when the pin is HIGH (default), or LOW with the
 * `activeLow` option (e.g. boards whose relay module triggers on a LOW level). While
 * energized the common contact swings to NO (normally-open), otherwise it rests on NC
 * (normally-closed). Tracks `energized` + `position` and a switch count for tests/UI.
 */
export class Relay implements SimComponent {
  energized = false;
  /** The throw COM is currently connected to ('NO' energized, 'NC' at rest). */
  position: RelayPosition = 'NC';
  /** Number of contact transitions (each coil energize/de-energize flips it once). */
  switches = 0;
  private host: CircuitHost | null = null;
  private readonly activeLow: boolean;

  constructor(
    readonly id: string,
    private readonly controlPin: number,
    opts: { activeLow?: boolean } = {},
  ) {
    this.activeLow = opts.activeLow ?? false;
  }

  attach(host: CircuitHost): void {
    this.host = host;
    this.update(host.pinLevel(this.controlPin));
    host.watchPin(this.controlPin, (level) => this.update(level));
  }

  /** Apply a control-pin level: energize per polarity, then settle the contact. */
  private update(level: 'low' | 'high'): void {
    const energized = this.activeLow ? level === 'low' : level === 'high';
    if (energized === this.energized) return;
    this.energized = energized;
    this.position = energized ? 'NO' : 'NC';
    this.switches++;
  }
}
