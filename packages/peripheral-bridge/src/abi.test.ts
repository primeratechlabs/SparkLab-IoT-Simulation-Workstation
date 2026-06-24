import { describe, it, expect } from 'vitest';
import { SabRing, decodeFrame, EVENT_TYPE_CODES, type BridgeEvent } from '@sparklab/shared';
import { encodeBridgeEvent, decodeBridgeFrame, pushBridgeEvent } from './abi.js';

describe('bridge ABI', () => {
  it('round-trips hot-path events through encode → decode', () => {
    const events: BridgeEvent[] = [
      { t: 100, type: 'gpio_write', pin: 13, value: 1 },
      { t: 200, type: 'gpio_mode', pin: 2, mode: 'input_pullup' },
      { t: 300, type: 'uart_tx', port: 0, bytes: [72, 105] },
      { t: 400, type: 'adc_read', pin: 14 },
      { t: 500, type: 'pwm_config', pin: 9, freqHz: 490, dutyFraction: 0.5 },
    ];
    for (const e of events) {
      const enc = encodeBridgeEvent(e)!;
      expect(enc).not.toBeNull();
      const back = decodeBridgeFrame(
        {
          timestamp: enc.timestamp,
          eventType: enc.eventType,
          busOrPin: enc.busOrPin,
          payloadOffset: 20,
          payloadLength: enc.payload.length,
        },
        enc.payload,
      );
      if (e.type === 'pwm_config' && back?.type === 'pwm_config') {
        expect(back.freqHz).toBe(490);
        expect(back.dutyFraction).toBeCloseTo(0.5, 5);
        expect(back.pin).toBe(9);
      } else {
        expect(back).toEqual(e);
      }
    }
  });

  it('returns null for control-channel (I2C/SPI) events', () => {
    expect(
      encodeBridgeEvent({ t: 0, type: 'i2c_write', bus: 0, address: '0x27', bytes: [1] }),
    ).toBeNull();
    expect(encodeBridgeEvent({ t: 0, type: 'spi_transfer', bus: 0, cs: 0, mosi: [1] })).toBeNull();
  });

  it('streams gpio events through the SAB ring and decodes them back', () => {
    const ring = SabRing.create(64, 64);
    pushBridgeEvent(ring, { t: 10, type: 'gpio_write', pin: 13, value: 1 });
    pushBridgeEvent(ring, { t: 20, type: 'gpio_write', pin: 13, value: 0 });
    // A control event is NOT pushed (returns false).
    expect(
      pushBridgeEvent(ring, { t: 30, type: 'i2c_write', bus: 0, address: '0x3c', bytes: [1] }),
    ).toBe(false);

    const raw1 = ring.pop()!;
    const decoded = decodeBridgeFrame(
      decodeFrame(raw1.buffer as ArrayBuffer).header,
      decodeFrame(raw1.buffer as ArrayBuffer).payload,
    );
    expect(decoded).toEqual({ t: 10, type: 'gpio_write', pin: 13, value: 1 });
    expect(ring.size).toBe(1); // only the two gpio events were pushed
  });

  it('does not throw on malformed pwm_config payloads', () => {
    expect(
      decodeBridgeFrame(
        {
          timestamp: 1n,
          eventType: EVENT_TYPE_CODES.pwm_config,
          busOrPin: 9,
          payloadOffset: 20,
          payloadLength: 2,
        },
        Uint8Array.of(1, 2),
      ),
    ).toBeNull();
  });
});
