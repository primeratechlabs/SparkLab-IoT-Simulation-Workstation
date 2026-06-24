/**
 * Bridge ABI — REFERENCE-SPEC §12/§31. Normalises the emulator's high-rate BridgeEvents
 * (GPIO edges, UART bytes, PWM/waveform) into the binary frame layout so they ride the
 * SharedArrayBuffer ring buffer (the hot path) instead of structured-clone JSON. Low-rate
 * control events (I2C/SPI transactions) stay on the JSON channel — `encodeBridgeEvent`
 * returns null for those so the caller routes them normally.
 */

import type { BridgeEvent } from '@sparklab/shared';
import { EVENT_TYPE_CODES, eventTypeName, type FrameHeader, type SabRing } from '@sparklab/shared';

export interface EncodedEvent {
  timestamp: bigint;
  eventType: number;
  busOrPin: number;
  payload: Uint8Array;
}

/** Encode a hot-path BridgeEvent into binary frame fields, or null for control events. */
export function encodeBridgeEvent(e: BridgeEvent): EncodedEvent | null {
  const timestamp = BigInt(Math.max(0, Math.round(e.t)));
  switch (e.type) {
    case 'gpio_write':
      return {
        timestamp,
        eventType: EVENT_TYPE_CODES.gpio_write,
        busOrPin: e.pin,
        payload: Uint8Array.of(e.value),
      };
    case 'gpio_read':
      return {
        timestamp,
        eventType: EVENT_TYPE_CODES.gpio_read,
        busOrPin: e.pin,
        payload: new Uint8Array(0),
      };
    case 'gpio_mode': {
      const mode = e.mode === 'output' ? 1 : e.mode === 'input_pullup' ? 2 : 0;
      return {
        timestamp,
        eventType: EVENT_TYPE_CODES.gpio_mode,
        busOrPin: e.pin,
        payload: Uint8Array.of(mode),
      };
    }
    case 'uart_tx':
      return {
        timestamp,
        eventType: EVENT_TYPE_CODES.uart_tx,
        busOrPin: e.port,
        payload: Uint8Array.from(e.bytes),
      };
    case 'adc_read':
      return {
        timestamp,
        eventType: EVENT_TYPE_CODES.adc_read,
        busOrPin: e.pin,
        payload: new Uint8Array(0),
      };
    case 'pwm_config': {
      const buf = new ArrayBuffer(8);
      const v = new DataView(buf);
      v.setUint32(0, Math.round(e.freqHz), true);
      v.setFloat32(4, e.dutyFraction, true);
      return {
        timestamp,
        eventType: EVENT_TYPE_CODES.pwm_config,
        busOrPin: e.pin,
        payload: new Uint8Array(buf),
      };
    }
    default:
      return null; // i2c/spi → JSON control channel
  }
}

/** Decode a binary frame back into a BridgeEvent (inverse of the hot-path encoding). */
export function decodeBridgeFrame(header: FrameHeader, payload: Uint8Array): BridgeEvent | null {
  const t = Number(header.timestamp);
  switch (eventTypeName(header.eventType)) {
    case 'gpio_write':
      return { t, type: 'gpio_write', pin: header.busOrPin, value: (payload[0] ?? 0) as 0 | 1 };
    case 'gpio_read':
      return { t, type: 'gpio_read', pin: header.busOrPin };
    case 'gpio_mode': {
      const mode = payload[0] === 1 ? 'output' : payload[0] === 2 ? 'input_pullup' : 'input';
      return { t, type: 'gpio_mode', pin: header.busOrPin, mode };
    }
    case 'uart_tx':
      return { t, type: 'uart_tx', port: header.busOrPin, bytes: Array.from(payload) };
    case 'adc_read':
      return { t, type: 'adc_read', pin: header.busOrPin };
    case 'pwm_config': {
      if (payload.byteLength < 8) return null;
      const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      return {
        t,
        type: 'pwm_config',
        pin: header.busOrPin,
        freqHz: v.getUint32(0, true),
        dutyFraction: v.getFloat32(4, true),
      };
    }
    default:
      return null;
  }
}

/** Push a hot-path BridgeEvent onto the ring (returns false if not hot-path or ring full). */
export function pushBridgeEvent(ring: SabRing, e: BridgeEvent): boolean {
  const enc = encodeBridgeEvent(e);
  if (!enc) return false;
  return ring.pushFrame(enc.timestamp, enc.eventType, enc.busOrPin, enc.payload);
}
