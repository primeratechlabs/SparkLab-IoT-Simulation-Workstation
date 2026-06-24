import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { RotaryEncoder, ENCODER_STEP_NS } from './rotary-encoder.js';

const CLK = 2;
const DT = 3;
const SW = 4;

describe('RotaryEncoder (KY-040)', () => {
  it('rests both quadrature lines + the button released (pull-ups read HIGH)', () => {
    const host = new MockCircuitHost();
    const enc = new RotaryEncoder('e', { clk: CLK, dt: DT, sw: SW });
    enc.attach(host);
    expect(host.driven.get(CLK)).toBe('high-z');
    expect(host.driven.get(DT)).toBe('high-z');
    expect(host.driven.get(SW)).toBe('high-z');
    expect(enc.clkLow).toBe(false);
    expect(enc.dtLow).toBe(false);
  });

  it('clockwise: CLK leads (DT still HIGH on the CLK falling edge); one detent advances position', () => {
    const host = new MockCircuitHost();
    const enc = new RotaryEncoder('e', { clk: CLK, dt: DT, sw: SW });
    enc.attach(host);
    enc.turn(1);

    host.advance(ENCODER_STEP_NS); // edge 1: CLK falls
    expect(host.driven.get(CLK)).toBe('low');
    expect(host.driven.get(DT)).toBe('high-z'); // DT still HIGH at the CLK falling edge ⇒ CW
    host.advance(ENCODER_STEP_NS); // edge 2: DT falls
    expect(host.driven.get(DT)).toBe('low');
    host.advance(ENCODER_STEP_NS); // edge 3: CLK rises
    expect(host.driven.get(CLK)).toBe('high-z');
    host.advance(ENCODER_STEP_NS); // edge 4: DT rises (back to rest)
    expect(host.driven.get(DT)).toBe('high-z');
    host.advance(ENCODER_STEP_NS); // detent counted
    expect(enc.position).toBe(1);
  });

  it('counter-clockwise: DT leads (DT LOW on the CLK falling edge); position decrements', () => {
    const host = new MockCircuitHost();
    const enc = new RotaryEncoder('e', { clk: CLK, dt: DT, sw: SW });
    enc.attach(host);
    enc.turn(-1);

    host.advance(ENCODER_STEP_NS); // edge 1: DT falls first
    expect(host.driven.get(DT)).toBe('low');
    expect(host.driven.get(CLK)).toBe('high-z'); // CLK still HIGH; DT already LOW ⇒ CCW
    host.advance(ENCODER_STEP_NS); // edge 2: CLK falls (DT LOW at this edge ⇒ CCW)
    expect(host.driven.get(CLK)).toBe('low');
    host.advance(4 * ENCODER_STEP_NS);
    expect(enc.position).toBe(-1);
    expect(host.driven.get(CLK)).toBe('high-z'); // back to rest
    expect(host.driven.get(DT)).toBe('high-z');
  });

  it('multiple detents accumulate; the button drives SW low while pressed', () => {
    const host = new MockCircuitHost();
    const enc = new RotaryEncoder('e', { clk: CLK, dt: DT, sw: SW });
    enc.attach(host);
    enc.turn(3);
    host.advance(20 * ENCODER_STEP_NS);
    expect(enc.position).toBe(3);

    enc.press();
    expect(host.driven.get(SW)).toBe('low');
    enc.release();
    expect(host.driven.get(SW)).toBe('high-z');
  });

  it('updates the commanded position SYNCHRONOUSLY so rapid delta-sets do not double-count', () => {
    const host = new MockCircuitHost();
    const enc = new RotaryEncoder('e', { clk: CLK, dt: DT, sw: SW });
    enc.attach(host);
    enc.turn(1);
    expect(enc.position).toBe(1); // already updated before any virtual time advances
    // mimic device-runtime applyProp('position', v) → turn(v - position), fired twice before time advances
    enc.turn(2 - enc.position); // → turn(1)
    expect(enc.position).toBe(2); // NOT 3 — the second set reads the fresh position, no double-count
    host.advance(20 * ENCODER_STEP_NS);
    expect(enc.position).toBe(2); // the emitted quadrature settles consistently
  });

  it('truncates a fractional detent (no spurious extra Gray cycle)', () => {
    const host = new MockCircuitHost();
    const enc = new RotaryEncoder('e', { clk: CLK, dt: DT, sw: SW });
    enc.attach(host);
    enc.turn(2.5); // a slider/text prop could send a fractional value
    expect(enc.position).toBe(2); // 2 whole detents, not 3
    enc.turn(-1.9);
    expect(enc.position).toBe(1); // truncates toward zero → -1
  });
});
