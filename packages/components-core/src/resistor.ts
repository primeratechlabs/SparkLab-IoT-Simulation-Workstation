import type { CircuitHost, SimComponent } from './sdk.js';

/** Passive 2-terminal resistor — a pure netlist/ERC element with no active behaviour.
 *  It drives nothing and watches nothing; `attach` is a no-op. The DC analog solver and
 *  the ERC read its `ohms` elsewhere (e.g. the LED-series-resistor / divider topology). */
export class Resistor implements SimComponent {
  constructor(
    readonly id: string,
    readonly ohms: number,
  ) {}

  attach(_host: CircuitHost): void {
    // Passive element: nothing to wire — its resistance is read from the netlist.
  }
}
