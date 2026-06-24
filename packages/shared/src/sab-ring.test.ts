import { describe, it, expect } from 'vitest';
import { SabRing } from './sab-ring.js';
import { EVENT_TYPE_CODES } from './binary-frame.js';

describe('SabRing', () => {
  it('pushes and pops frames in FIFO order', () => {
    const ring = SabRing.create(8, 32);
    expect(ring.push(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(ring.push(new Uint8Array([4, 5]))).toBe(true);
    expect(ring.size).toBe(2);
    expect(Array.from(ring.pop()!)).toEqual([1, 2, 3]);
    expect(Array.from(ring.pop()!)).toEqual([4, 5]);
    expect(ring.pop()).toBeNull(); // empty
  });

  it('reports full and refuses the overflowing push (load shedding, I9)', () => {
    const ring = SabRing.create(4, 16); // capacity = slotCount - 1 = 3
    expect(ring.capacity).toBe(3);
    expect(ring.push(new Uint8Array([1]))).toBe(true);
    expect(ring.push(new Uint8Array([2]))).toBe(true);
    expect(ring.push(new Uint8Array([3]))).toBe(true);
    expect(ring.push(new Uint8Array([4]))).toBe(false); // full
    expect(ring.size).toBe(3);
  });

  it('wraps around the slot grid correctly', () => {
    const ring = SabRing.create(4, 16);
    for (let cycle = 0; cycle < 10; cycle++) {
      expect(ring.push(new Uint8Array([cycle]))).toBe(true);
      expect(Array.from(ring.pop()!)).toEqual([cycle]); // head/tail both advance past the wrap
    }
    expect(ring.size).toBe(0);
  });

  it('rejects a frame larger than a slot', () => {
    const ring = SabRing.create(4, 16); // payload room = 12
    expect(() => ring.push(new Uint8Array(20))).toThrow(/exceeds slot/);
  });

  it('rejects invalid ring dimensions', () => {
    expect(() => SabRing.create(1, 16)).toThrow(/slotCount/);
    expect(() => SabRing.create(4.5, 16)).toThrow(/slotCount/);
    expect(() => SabRing.create(4, 15.5)).toThrow(/slotBytes/);
  });

  it('discards a corrupt slot length and lets the consumer continue', () => {
    const ring = SabRing.create(4, 16);
    ring.push(Uint8Array.of(1));
    ring.push(Uint8Array.of(2));
    new DataView(ring.sab, 8).setUint32(0, 1000, true);
    expect(() => ring.pop()).toThrow(/corrupt ring slot/);
    expect(Array.from(ring.pop()!)).toEqual([2]);
  });

  it('shares one SharedArrayBuffer between a producer and a consumer view', () => {
    const producer = SabRing.create(16, 64);
    const consumer = SabRing.attach(producer.sab, 16, 64);
    producer.pushFrame(123n, EVENT_TYPE_CODES.gpio_write, 13, new Uint8Array([1]));
    const frame = consumer.popFrame()!;
    expect(frame.header.timestamp).toBe(123n);
    expect(frame.header.eventType).toBe(EVENT_TYPE_CODES.gpio_write);
    expect(frame.header.busOrPin).toBe(13);
    expect(Array.from(frame.payload)).toEqual([1]);
  });

  it('round-trips many frames through the SAB transport', () => {
    const ring = SabRing.create(1024, 64);
    for (let i = 0; i < 5000; i++) {
      expect(ring.pushFrame(BigInt(i), EVENT_TYPE_CODES.gpio_write, i & 0xff)).toBe(true);
      const f = ring.popFrame()!;
      expect(f.header.timestamp).toBe(BigInt(i));
      expect(f.header.busOrPin).toBe(i & 0xff);
    }
  });
});
