import { describe, it, expect } from 'vitest';
import { IrReceiver } from './ir-receiver.js';
import { IrRemote } from './ir-remote.js';
import { MockCircuitHost } from './mock-host.js';

const DAT = 8;

/** Capture the DAT waveform the receiver plays and decode it back to a NEC (address, command). */
function playAndDecode(trigger: (rx: IrReceiver, host: MockCircuitHost) => void): {
  address: number;
  command: number;
} {
  const rx = new IrReceiver('rx', DAT);
  const host = new MockCircuitHost();
  rx.attach(host);
  const events: Array<{ lvl: string; at: number }> = [];
  const orig = host.drivePin.bind(host);
  host.drivePin = (pin, lvl) => {
    if (pin === DAT) events.push({ lvl, at: host.now() });
    return orig(pin, lvl);
  };
  trigger(rx, host);
  host.advance(200_000_000); // 200ms — past the whole ~68ms frame

  // (level, duration) pairs
  const pairs: Array<{ lvl: string; us: number }> = [];
  for (let i = 1; i < events.length; i++) {
    pairs.push({ lvl: events[i - 1]!.lvl, us: (events[i]!.at - events[i - 1]!.at) / 1000 });
  }
  // pairs: [LOW 9000, HIGH 4500, (LOW 560, HIGH space)×32, LOW 560]. The bit spaces are the HIGHs at
  // odd indices ≥ 3; a space > ~1ms is a '1'.
  const bits: number[] = [];
  for (let i = 3; i < pairs.length && bits.length < 32; i += 2)
    bits.push(pairs[i]!.us > 1000 ? 1 : 0);
  const byte = (o: number): number => bits.slice(o, o + 8).reduce((v, b, i) => v | (b << i), 0);
  return { address: byte(0), command: byte(16) };
}

describe('IR receiver + remote (NEC)', () => {
  it('plays a decodable NEC frame for an inspector-set command', () => {
    const { address, command } = playAndDecode((rx) => rx.receive(0x45));
    expect(address).toBe(0x00);
    expect(command).toBe(0x45);
  });

  it('carries an arbitrary command byte intact', () => {
    expect(playAndDecode((rx) => rx.receive(0xa3)).command).toBe(0xa3);
  });

  it('a same-circuit IR remote drives the receiver', () => {
    const host = new MockCircuitHost();
    const rx = new IrReceiver('rx', DAT);
    const remote = new IrRemote('rc');
    rx.attach(host);
    remote.attach(host);
    remote.press(0x19);
    expect(rx.lastCommand).toBe(0x19);
    expect(remote.lastKey).toBe(0x19);
  });

  it('a remote reaches only receivers in its own circuit', () => {
    const hostA = new MockCircuitHost();
    const hostB = new MockCircuitHost();
    const rxA = new IrReceiver('a', DAT);
    const rxB = new IrReceiver('b', DAT);
    rxA.attach(hostA);
    rxB.attach(hostB);
    const remoteA = new IrRemote('rc');
    remoteA.attach(hostA);
    remoteA.press(0x07);
    expect(rxA.lastCommand).toBe(0x07);
    expect(rxB.lastCommand).toBe(-1); // untouched — different circuit
  });
});
