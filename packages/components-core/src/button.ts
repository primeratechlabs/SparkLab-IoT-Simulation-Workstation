import type { CircuitHost, SimComponent } from './sdk.js';

/** Momentary push-button wired to GND with the MCU pin in INPUT_PULLUP: pressed pulls
 *  the line LOW, released leaves it floating (the MCU pull-up reads HIGH). */
export class PushButton implements SimComponent {
  private host: CircuitHost | null = null;
  private pressed = false;
  constructor(
    readonly id: string,
    private readonly pin: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.apply();
  }

  press(): void {
    this.pressed = true;
    this.apply();
  }
  release(): void {
    this.pressed = false;
    this.apply();
  }
  set isPressed(v: boolean) {
    this.pressed = v;
    this.apply();
  }

  private apply(): void {
    this.host?.drivePin(this.pin, this.pressed ? 'low' : 'high-z');
  }
}
