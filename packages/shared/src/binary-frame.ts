/**
 * Binary hot-path frame codec — REFERENCE-SPEC §12, BinaryEventFrameLayout.
 *
 * Layout (little-endian), 20-byte fixed header followed by an opaque payload:
 *   timestamp      uint64  @0   (virtual-time nanoseconds)
 *   event_type     uint16  @8
 *   bus_or_pin     uint16  @10
 *   payload_offset uint32  @12  (absolute byte offset of payload in the buffer)
 *   payload_length uint32  @16
 *
 * Used over SharedArrayBuffer ring buffers on the emulator<->kernel hot path so
 * we never JSON-serialize per-event (invariant I2 / perf budgets §17).
 */

export const FRAME_HEADER_BYTES = 20;

/** Numeric codes for BridgeEvent/BridgeInput `type` discriminants. Stable wire ids. */
export const EVENT_TYPE_CODES = {
  gpio_write: 1,
  gpio_read: 2,
  gpio_mode: 3,
  uart_tx: 4,
  i2c_write: 5,
  i2c_read: 6,
  spi_transfer: 7,
  adc_read: 8,
  pwm_config: 9,
  // reverse direction (kernel -> emulator)
  gpio_input: 64,
  adc_value: 65,
  uart_rx: 66,
  i2c_slave_reply: 67,
  spi_miso: 68,
} as const;

export type EventTypeName = keyof typeof EVENT_TYPE_CODES;

const CODE_TO_NAME: Record<number, EventTypeName> = Object.fromEntries(
  Object.entries(EVENT_TYPE_CODES).map(([k, v]) => [v, k as EventTypeName]),
) as Record<number, EventTypeName>;

export function eventTypeName(code: number): EventTypeName | undefined {
  return CODE_TO_NAME[code];
}

export interface FrameHeader {
  timestamp: bigint;
  eventType: number;
  busOrPin: number;
  payloadOffset: number;
  payloadLength: number;
}

/** Write a frame header into `view` at `byteOffset`. Returns bytes written (20). */
export function writeFrameHeader(view: DataView, byteOffset: number, header: FrameHeader): number {
  view.setBigUint64(byteOffset + 0, header.timestamp, true);
  view.setUint16(byteOffset + 8, header.eventType, true);
  view.setUint16(byteOffset + 10, header.busOrPin, true);
  view.setUint32(byteOffset + 12, header.payloadOffset, true);
  view.setUint32(byteOffset + 16, header.payloadLength, true);
  return FRAME_HEADER_BYTES;
}

export function readFrameHeader(view: DataView, byteOffset: number): FrameHeader {
  return {
    timestamp: view.getBigUint64(byteOffset + 0, true),
    eventType: view.getUint16(byteOffset + 8, true),
    busOrPin: view.getUint16(byteOffset + 10, true),
    payloadOffset: view.getUint32(byteOffset + 12, true),
    payloadLength: view.getUint32(byteOffset + 16, true),
  };
}

/**
 * Encode a single self-contained frame: [header | payload] in one ArrayBuffer.
 * payload_offset points just past the header.
 */
export function encodeFrame(
  timestamp: bigint,
  eventType: number,
  busOrPin: number,
  payload: Uint8Array = new Uint8Array(0),
): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(buf);
  writeFrameHeader(view, 0, {
    timestamp,
    eventType,
    busOrPin,
    payloadOffset: FRAME_HEADER_BYTES,
    payloadLength: payload.length,
  });
  new Uint8Array(buf).set(payload, FRAME_HEADER_BYTES);
  return buf;
}

export function decodeFrame(buf: ArrayBuffer): { header: FrameHeader; payload: Uint8Array } {
  if (buf.byteLength < FRAME_HEADER_BYTES) throw new Error('frame buffer shorter than header');
  const view = new DataView(buf);
  const header = readFrameHeader(view, 0);
  // Lower bound: payload must start past the fixed header, else a crafted frame
  // could alias header bytes as payload. Upper bound: payload must stay in buffer.
  if (header.payloadOffset < FRAME_HEADER_BYTES) {
    throw new Error('frame payload offset inside header');
  }
  if (header.payloadOffset + header.payloadLength > buf.byteLength) {
    throw new Error('frame payload out of bounds');
  }
  const payload = new Uint8Array(buf, header.payloadOffset, header.payloadLength);
  return { header, payload };
}
