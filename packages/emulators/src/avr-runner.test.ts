import { describe, it, expect } from 'vitest';
import { PinState } from 'avr8js';
import { AVRRunner, digitalPinToPort, analogPinToChannel, UNO_CLOCK_HZ } from './avr-runner.js';

// Tiny hand-assembled AVR opcode helpers (just enough to drive GPIO from tests
// without pulling in a full toolchain). Bit layouts per the ATmega328P ISA.
const ldi = (d: number, k: number) => 0xe000 | ((k & 0xf0) << 4) | ((d - 16) << 4) | (k & 0x0f); // LDI Rd,K (d 16..31)
const out = (a: number, r: number) => 0xb800 | ((a & 0x30) << 5) | ((r & 0x1f) << 4) | (a & 0x0f); // OUT A,Rr
const inn = (d: number, a: number) => 0xb000 | ((a & 0x30) << 5) | ((d & 0x1f) << 4) | (a & 0x0f); // IN Rd,A
const andi = (d: number, k: number) => 0x7000 | ((k & 0xf0) << 4) | ((d - 16) << 4) | (k & 0x0f); // ANDI Rd,K
const breq = (k: number) => 0xf000 | ((k & 0x7f) << 3) | 0x01; // BREQ k (words)
const rjmp = (k: number) => 0xc000 | (k & 0x0fff); // RJMP k (words)

/** Pack 16-bit little-endian words into a flash image. */
function program(words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 2);
  words.forEach((w, i) => {
    bytes[i * 2] = w & 0xff;
    bytes[i * 2 + 1] = (w >> 8) & 0xff;
  });
  return bytes;
}

// I/O register addresses (I/O space, usable with IN/OUT). DDRB drives direction,
// PORTB the output latch, PIND the input register for PORTD.
const DDRB = 0x04;
const PORTB = 0x05;
const PIND = 0x09;

describe('Arduino Uno pin mapping', () => {
  it('maps digital pins D0–D7 to PORTD, D8–D13 to PORTB', () => {
    expect(digitalPinToPort(0)).toEqual({ port: 'D', index: 0 });
    expect(digitalPinToPort(7)).toEqual({ port: 'D', index: 7 });
    expect(digitalPinToPort(8)).toEqual({ port: 'B', index: 0 });
    expect(digitalPinToPort(13)).toEqual({ port: 'B', index: 5 }); // LED_BUILTIN
  });

  it('rejects out-of-range digital pins', () => {
    expect(() => digitalPinToPort(14)).toThrow();
    expect(() => digitalPinToPort(-1)).toThrow();
  });

  it('maps analog pins A0–A5 to ADC channels, rejects others', () => {
    expect(analogPinToChannel(0)).toBe(0);
    expect(analogPinToChannel(5)).toBe(5);
    expect(() => analogPinToChannel(6)).toThrow();
  });
});

describe('AVRRunner', () => {
  const emptyProgram = new Uint8Array(64); // all NOPs

  it('derives virtual time from the cycle counter (I3)', () => {
    const r = new AVRRunner(emptyProgram);
    expect(r.virtualTimeNs).toBe(0);
    r.execute(UNO_CLOCK_HZ); // 1 second of cycles
    // ~1e9 ns, within rounding of one instruction.
    expect(r.virtualTimeNs).toBeGreaterThan(0.99e9);
    expect(r.virtualTimeNs).toBeLessThan(1.02e9);
  });

  it('clamps analog input voltage to 0..5V and rejects bad channels', () => {
    const r = new AVRRunner(emptyProgram);
    r.setAnalogVoltage(0, 9);
    expect(r.adc.channelValues[0]).toBe(5);
    r.setAnalogVoltage(0, -3);
    expect(r.adc.channelValues[0]).toBe(0);
    expect(() => r.setAnalogVoltage(8, 1)).toThrow();
    expect(() => r.setAnalogVoltage(-1, 1)).toThrow();
  });

  it('rejects NaN/Infinity analog voltage instead of corrupting the ADC', () => {
    const r = new AVRRunner(emptyProgram);
    r.setAnalogVoltage(0, 2.5); // seed a known-good level
    expect(() => r.setAnalogVoltage(0, NaN)).toThrow();
    expect(() => r.setAnalogVoltage(0, Infinity)).toThrow();
    expect(() => r.setAnalogVoltage(0, -Infinity)).toThrow();
    // The bad writes must not have leaked through the Math.max/min clamp.
    expect(r.adc.channelValues[0]).toBe(2.5);
  });

  it('step() executes exactly one instruction', () => {
    const r = new AVRRunner(emptyProgram); // all NOPs (opcode 0x0000)
    expect(r.cpu.pc).toBe(0);
    expect(r.cpu.cycles).toBe(0);
    r.step();
    expect(r.cpu.pc).toBe(1); // one word advanced
    expect(r.cpu.cycles).toBe(1); // NOP is a single cycle
  });

  it('pinState()/digitalRead() reflect levels the firmware drives onto a pin', () => {
    // Set PB5 (D13) as output and drive it high, then spin.
    const r = new AVRRunner(
      program([
        ldi(16, 0x20), // r16 = bit5 mask
        out(DDRB, 16), // PB5 = output
        out(PORTB, 16), // PB5 = high
        rjmp(-1), // self loop
      ]),
    );
    for (let i = 0; i < 10; i++) r.step();
    expect(r.pinState('B', 5)).toBe(PinState.High);
    expect(r.digitalRead(13)).toBe(true);
  });

  it('setDigitalInput() drives an input pin the firmware can read back', () => {
    // Firmware mirrors PIND bit2 (D2) onto PB0 so we can observe the input level.
    const r = new AVRRunner(
      program([
        ldi(16, 0x01),
        out(DDRB, 16), //  0..1  PB0 = output
        inn(17, PIND), //  2     loop: r17 = PIND
        andi(17, 0x04), // 3     isolate bit2
        breq(4), //        4     if zero, jump to clear (pc 5 + 4 = 9)
        ldi(18, 0x01), //  5
        out(PORTB, 18), // 6     PB0 = high
        rjmp(-6), //       7     back to loop (pc 8 - 6 = 2)
        0x0000, //         8     padding so clear lands at pc 9
        ldi(18, 0x00), //  9     clear:
        out(PORTB, 18), // 10    PB0 = low
        rjmp(-10), //      11    back to loop (pc 12 - 10 = 2)
      ]),
    );

    r.setDigitalInput(2, true);
    for (let i = 0; i < 200; i++) r.step();
    expect(r.pinState('B', 0)).toBe(PinState.High);

    r.setDigitalInput(2, false);
    for (let i = 0; i < 200; i++) r.step();
    expect(r.pinState('B', 0)).toBe(PinState.Low);
  });

  it('rejects firmware larger than the 32KB flash instead of truncating silently', () => {
    expect(() => new AVRRunner(new Uint8Array(0x8000 + 1))).toThrow(/too large/);
  });

  it('execute() advances by approximately the requested cycles', () => {
    const r = new AVRRunner(emptyProgram);
    const ran = r.execute(1000);
    expect(ran).toBeGreaterThanOrEqual(1000);
    expect(r.cpu.cycles).toBe(ran);
  });
});
