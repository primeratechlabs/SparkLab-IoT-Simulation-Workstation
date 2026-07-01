import type { CircuitHost, SimComponent } from './sdk.js';

const US = 1000; // µs → ns
// NEC protocol timings. The demodulated output of a VS1838B-class receiver is ACTIVE-LOW: idle HIGH,
// a carrier burst ("mark") pulls it LOW, the gap ("space") is HIGH.
const LEADER_MARK = 9000 * US;
const LEADER_SPACE = 4500 * US;
const BIT_MARK = 560 * US;
const ZERO_SPACE = 560 * US;
const ONE_SPACE = 1690 * US;

/** Every receiver keyed by the circuit host it attached to, so a same-circuit IR remote can reach it. */
export const IR_RECEIVERS = new WeakMap<CircuitHost, Set<IrReceiver>>();

/**
 * IR receiver module (VS1838B-class) on a single data pin (DAT), plus VCC/GND. It demodulates the 38 kHz
 * carrier internally, so DAT carries the raw NEC frame ACTIVE-LOW. `receive(address, command)` plays a
 * real NEC frame (9ms leader, 32 LSB-first bits with pulse-distance encoding, final burst) on the virtual
 * clock, which the Arduino IRremote library decodes. A frame can be triggered from the inspector
 * (`command`) or by a same-circuit {@link IrRemote}.
 */
export class IrReceiver implements SimComponent {
  private host: CircuitHost | null = null;
  lastCommand = -1;
  private busy = false;

  constructor(
    readonly id: string,
    private readonly datPin: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    host.drivePin(this.datPin, 'high'); // idle HIGH (no carrier)
    let set = IR_RECEIVERS.get(host);
    if (!set) IR_RECEIVERS.set(host, (set = new Set()));
    set.add(this);
  }

  /** Play one NEC frame; `address` defaults to 0x00. Ignored while a frame is already in flight. */
  receive(command: number, address = 0x00): void {
    const host = this.host;
    if (!host || this.busy) return;
    this.busy = true;
    this.lastCommand = command & 0xff;
    const segs = necSegments(address & 0xff, command & 0xff);
    this.play(segs, 0);
  }

  private play(segs: Array<{ level: 'low' | 'high'; ns: number }>, i: number): void {
    const host = this.host;
    if (!host) return;
    if (i >= segs.length) {
      host.drivePin(this.datPin, 'high'); // return to idle
      this.busy = false;
      return;
    }
    host.drivePin(this.datPin, segs[i]!.level);
    host.schedule(segs[i]!.ns, () => this.play(segs, i + 1));
  }
}

/** Build the ACTIVE-LOW NEC segment list for (address, command), LSB-first with the inverted bytes. */
function necSegments(
  address: number,
  command: number,
): Array<{ level: 'low' | 'high'; ns: number }> {
  const segs: Array<{ level: 'low' | 'high'; ns: number }> = [
    { level: 'low', ns: LEADER_MARK },
    { level: 'high', ns: LEADER_SPACE },
  ];
  const bytes = [address, ~address & 0xff, command, ~command & 0xff];
  for (const b of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      segs.push({ level: 'low', ns: BIT_MARK }); // every bit starts with a 560µs mark
      segs.push({ level: 'high', ns: (b >> bit) & 1 ? ONE_SPACE : ZERO_SPACE }); // LSB first
    }
  }
  segs.push({ level: 'low', ns: BIT_MARK }); // final burst
  return segs;
}
