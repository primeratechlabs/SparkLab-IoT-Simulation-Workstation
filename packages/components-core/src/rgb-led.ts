import type { CircuitHost, SimComponent } from './sdk.js';

/** One of the three colour channels' intensity: 0 (off) or 255 (full on). Digital-only
 *  for now — no PWM dimming, so each channel is purely on/off. */
type Channel = 0 | 255;

/** The colour an {@link RgbLed} is currently emitting (per-channel intensity). */
export interface RgbColor {
  r: Channel;
  g: Channel;
  b: Channel;
}

/** RGB LED driven by three GPIO pins, common-cathode (shared cathode to GND, each anode
 *  through a series resistor to its pin). A pin driven HIGH lights that channel; LOW (or
 *  released → high-z, read as LOW) leaves it dark. Tracks each channel via watchPin so
 *  `color`/`on` stay current. Digital only — full HIGH = 255, no PWM dimming yet. */
export class RgbLed implements SimComponent {
  private red = false;
  private green = false;
  private blue = false;
  constructor(
    readonly id: string,
    private readonly rPin: number,
    private readonly gPin: number,
    private readonly bPin: number,
  ) {}

  attach(host: CircuitHost): void {
    // Seed from the MCU's current levels, then track each channel independently.
    this.red = host.pinLevel(this.rPin) === 'high';
    this.green = host.pinLevel(this.gPin) === 'high';
    this.blue = host.pinLevel(this.bPin) === 'high';
    host.watchPin(this.rPin, (level) => {
      this.red = level === 'high';
    });
    host.watchPin(this.gPin, (level) => {
      this.green = level === 'high';
    });
    host.watchPin(this.bPin, (level) => {
      this.blue = level === 'high';
    });
  }

  /** The emitted colour: each channel is 0 (off) or 255 (full on). */
  get color(): RgbColor {
    return {
      r: this.red ? 255 : 0,
      g: this.green ? 255 : 0,
      b: this.blue ? 255 : 0,
    };
  }

  /** True when any channel is lit. */
  get on(): boolean {
    return this.red || this.green || this.blue;
  }
}
