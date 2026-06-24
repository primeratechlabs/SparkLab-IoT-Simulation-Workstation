import { describe, expect, it } from 'vitest';
import { ProtocolInspector, formatHexBytes, formatI2cAddress } from './protocol-inspector.js';

describe('ProtocolInspector', () => {
  it('captures I2C writes and pairs reads with the matching slave reply', () => {
    const inspector = new ProtocolInspector();

    inspector.ingest({ t: 100, type: 'i2c_write', bus: 0, address: '0x27', bytes: [0x41, 0x42] });
    inspector.ingest({ t: 200, type: 'i2c_read', bus: 1, address: '60', length: 2 });
    inspector.ingest({
      t: 220,
      type: 'i2c_slave_reply',
      bus: 1,
      address: '0x3c',
      bytes: [0xde, 0xad],
    });

    expect(inspector.i2cTransactions()).toEqual([
      {
        id: 1,
        tNs: 100,
        bus: 0,
        address: 0x27,
        direction: 'write',
        requestedLength: 2,
        bytes: [0x41, 0x42],
        reply: [],
        status: 'complete',
      },
      {
        id: 2,
        tNs: 200,
        bus: 1,
        address: 0x3c,
        direction: 'read',
        requestedLength: 2,
        bytes: [],
        reply: [0xde, 0xad],
        status: 'complete',
      },
    ]);
  });

  it('marks a short I2C reply partial and leaves unmatched replies visible', () => {
    const inspector = new ProtocolInspector();
    inspector.ingest({ t: 10, type: 'i2c_read', bus: 0, address: '0x68', length: 3 });
    inspector.ingest({ t: 11, type: 'i2c_slave_reply', bus: 0, address: '0x68', bytes: [1] });
    inspector.ingest({ t: 12, type: 'i2c_slave_reply', bus: 2, address: '0x40', bytes: [2] });

    expect(inspector.i2cTransactions()[0]!.status).toBe('partial');
    expect(inspector.unmatchedReplies).toBe(1);
  });

  it('pairs SPI MOSI with MISO on bus and chip-select', () => {
    const inspector = new ProtocolInspector();
    inspector.ingest({ t: 300, type: 'spi_transfer', bus: 0, cs: 10, mosi: [0x9f, 0, 0] });
    inspector.ingest({ t: 301, type: 'spi_miso', bus: 0, cs: 10, miso: [0, 0xef, 0x40] });

    expect(inspector.spiTransactions()[0]).toMatchObject({
      bus: 0,
      cs: 10,
      mosi: [0x9f, 0, 0],
      miso: [0, 0xef, 0x40],
      status: 'complete',
    });
  });

  it('captures UART in both directions with text and line-ending metadata', () => {
    const inspector = new ProtocolInspector();
    inspector.ingest({ t: 400, type: 'uart_tx', port: 0, bytes: [72, 105, 13, 10] });
    inspector.ingest({ t: 500, type: 'uart_rx', port: 0, bytes: [79, 75, 10] });

    expect(inspector.uartChunks()).toEqual([
      expect.objectContaining({ direction: 'tx', text: 'Hi\\r\\n', lineEnding: 'crlf' }),
      expect.objectContaining({ direction: 'rx', text: 'OK\\n', lineEnding: 'lf' }),
    ]);
  });

  it('normalizes bytes and bounds retained protocol entries', () => {
    const inspector = new ProtocolInspector({ maxEntries: 2, maxUartBytes: 3 });
    inspector.ingest({ t: 1, type: 'i2c_write', bus: 0, address: '0x20', bytes: [-1, 256, 511] });
    inspector.ingest({ t: 2, type: 'i2c_write', bus: 0, address: '0x21', bytes: [1] });
    inspector.ingest({ t: 3, type: 'i2c_write', bus: 0, address: '0x22', bytes: [2] });
    inspector.ingest({ t: 4, type: 'uart_tx', port: 0, bytes: [65, 66] });
    inspector.ingest({ t: 5, type: 'uart_tx', port: 0, bytes: [67, 68] });

    expect(inspector.i2cTransactions().map((tx) => tx.address)).toEqual([0x21, 0x22]);
    expect(inspector.uartChunks().flatMap((chunk) => chunk.bytes)).toEqual([66, 67, 68]);
    expect(inspector.droppedUartBytes).toBe(1);
  });

  it('formats empty and populated byte arrays consistently', () => {
    expect(formatHexBytes([])).toBe('—');
    expect(formatHexBytes([0, 10, 255])).toBe('00 0A FF');
    expect(formatI2cAddress(Number.NaN)).toBe('0x00');
  });
});
