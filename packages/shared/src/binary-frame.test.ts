import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  decodeFrame,
  writeFrameHeader,
  EVENT_TYPE_CODES,
  eventTypeName,
  FRAME_HEADER_BYTES,
} from './binary-frame.js';

describe('binary-frame', () => {
  it('round-trips a gpio_write frame with payload', () => {
    const payload = new Uint8Array([1]);
    const buf = encodeFrame(123456789n, EVENT_TYPE_CODES.gpio_write, 13, payload);
    const { header, payload: out } = decodeFrame(buf);
    expect(header.timestamp).toBe(123456789n);
    expect(header.eventType).toBe(EVENT_TYPE_CODES.gpio_write);
    expect(header.busOrPin).toBe(13);
    expect(header.payloadOffset).toBe(FRAME_HEADER_BYTES);
    expect(header.payloadLength).toBe(1);
    expect(Array.from(out)).toEqual([1]);
  });

  it('handles empty payload', () => {
    const buf = encodeFrame(0n, EVENT_TYPE_CODES.adc_read, 5);
    const { header, payload } = decodeFrame(buf);
    expect(header.payloadLength).toBe(0);
    expect(payload.length).toBe(0);
  });

  it('preserves 64-bit virtual timestamps beyond 2^53', () => {
    const t = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a JS number
    const buf = encodeFrame(t, EVENT_TYPE_CODES.uart_tx, 0, new Uint8Array([72, 105]));
    expect(decodeFrame(buf).header.timestamp).toBe(t);
  });

  it('maps event-type codes back to names', () => {
    expect(eventTypeName(EVENT_TYPE_CODES.i2c_write)).toBe('i2c_write');
    expect(eventTypeName(9999)).toBeUndefined();
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => decodeFrame(new ArrayBuffer(FRAME_HEADER_BYTES - 1))).toThrow(
      /shorter than header/,
    );
  });

  it('rejects a crafted payloadOffset that aliases header bytes', () => {
    // A valid-looking frame whose payloadOffset points inside the fixed header.
    const buf = new ArrayBuffer(FRAME_HEADER_BYTES + 4);
    const view = new DataView(buf);
    writeFrameHeader(view, 0, {
      timestamp: 0n,
      eventType: EVENT_TYPE_CODES.gpio_write,
      busOrPin: 0,
      payloadOffset: 8, // inside the 20-byte header -> must be rejected
      payloadLength: 4,
    });
    expect(() => decodeFrame(buf)).toThrow(/inside header/);
  });

  it('rejects a zero-length payload whose offset still lies inside the header', () => {
    const buf = new ArrayBuffer(FRAME_HEADER_BYTES);
    const view = new DataView(buf);
    writeFrameHeader(view, 0, {
      timestamp: 0n,
      eventType: EVENT_TYPE_CODES.adc_read,
      busOrPin: 0,
      payloadOffset: 4, // inside header; length 0 must not slip past the bound check
      payloadLength: 0,
    });
    expect(() => decodeFrame(buf)).toThrow(/inside header/);
  });

  it('accepts a zero-length payload with offset exactly past the header', () => {
    const buf = new ArrayBuffer(FRAME_HEADER_BYTES);
    const view = new DataView(buf);
    writeFrameHeader(view, 0, {
      timestamp: 0n,
      eventType: EVENT_TYPE_CODES.adc_read,
      busOrPin: 0,
      payloadOffset: FRAME_HEADER_BYTES,
      payloadLength: 0,
    });
    const { header, payload } = decodeFrame(buf);
    expect(header.payloadOffset).toBe(FRAME_HEADER_BYTES);
    expect(payload.length).toBe(0);
  });

  it('rejects a payload that runs past the buffer end', () => {
    const buf = new ArrayBuffer(FRAME_HEADER_BYTES + 2);
    const view = new DataView(buf);
    writeFrameHeader(view, 0, {
      timestamp: 0n,
      eventType: EVENT_TYPE_CODES.uart_tx,
      busOrPin: 0,
      payloadOffset: FRAME_HEADER_BYTES,
      payloadLength: 8, // claims more bytes than the buffer holds
    });
    expect(() => decodeFrame(buf)).toThrow(/out of bounds/);
  });
});
