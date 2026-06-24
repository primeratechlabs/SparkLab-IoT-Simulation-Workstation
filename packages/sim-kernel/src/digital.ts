/**
 * Digital Net Engine — REFERENCE-SPEC Stage 3. A net is the electrical node joining
 * connected pins; it resolves the logic level from every driver + pull resistor and
 * notifies listeners only when the resolved level changes (event-driven, no polling).
 *
 * Resolution model (digital, not full SPICE):
 *   - a pin drives 'low' | 'high' | 'high-z' (high-z = input / not driving);
 *   - a strong low and a strong high at once = contention (short) → flagged for ERC,
 *     resolved deterministically to 'low' so the sim stays defined;
 *   - with no strong driver, a pull-up → 'high', pull-down → 'low', both/none →
 *     'floating' (an undriven input the ERC can warn about).
 */

export type PinLevel = 'low' | 'high' | 'floating';
export type DriveState = 'low' | 'high' | 'high-z';
export type Pull = 'none' | 'up' | 'down';

export interface NetResolution {
  level: PinLevel;
  /** Two drivers fighting (strong low + strong high) — a short the ERC reports. */
  conflict: boolean;
}

export type NetListener = (resolution: NetResolution) => void;

export class DigitalNet {
  private readonly drivers = new Map<string, DriveState>();
  private readonly pulls = new Map<string, Pull>();
  private readonly listeners = new Set<NetListener>();
  private resolution: NetResolution = { level: 'floating', conflict: false };

  constructor(readonly id: string = 'net') {}

  get level(): PinLevel {
    return this.resolution.level;
  }
  get conflict(): boolean {
    return this.resolution.conflict;
  }

  /** Set (or clear, with 'high-z') what a pin drives onto the net. */
  drive(pinId: string, state: DriveState): void {
    if (state === 'high-z') this.drivers.delete(pinId);
    else this.drivers.set(pinId, state);
    this.recompute();
  }

  /** Attach/replace a pin's pull resistor on the net ('none' detaches it). */
  setPull(pinId: string, pull: Pull): void {
    if (pull === 'none') this.pulls.delete(pinId);
    else this.pulls.set(pinId, pull);
    this.recompute();
  }

  /** Subscribe to resolved-level changes; returns an unsubscribe fn. */
  onChange(listener: NetListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Current resolution snapshot. */
  resolve(): NetResolution {
    return this.resolution;
  }

  private recompute(): void {
    let strongLow = false;
    let strongHigh = false;
    for (const s of this.drivers.values()) {
      if (s === 'low') strongLow = true;
      else if (s === 'high') strongHigh = true;
    }

    let level: PinLevel;
    const conflict = strongLow && strongHigh;
    if (conflict) {
      level = 'low'; // contention resolves low deterministically; ERC flags the short
    } else if (strongHigh) {
      level = 'high';
    } else if (strongLow) {
      level = 'low';
    } else {
      // No strong driver: pull resistors decide.
      let up = false;
      let down = false;
      for (const p of this.pulls.values()) {
        if (p === 'up') up = true;
        else if (p === 'down') down = true;
      }
      level = up && !down ? 'high' : down && !up ? 'low' : 'floating';
    }

    if (level !== this.resolution.level || conflict !== this.resolution.conflict) {
      this.resolution = { level, conflict };
      for (const l of this.listeners) l(this.resolution);
    }
  }
}
