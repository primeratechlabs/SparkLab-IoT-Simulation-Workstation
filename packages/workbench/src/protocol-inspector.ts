/**
 * Protocol inspectors consume the normative bridge ABI and retain a bounded,
 * presentation-ready transaction history. Request/reply pairs are correlated without
 * wall-clock state so replaying the same virtual-time stream produces the same view.
 */

import type { BridgeEvent, BridgeInput } from '@sparklab/shared';

export type ProtocolInput = BridgeEvent | BridgeInput;
export type TransactionStatus = 'pending' | 'partial' | 'complete';

export interface I2cTransaction {
  id: number;
  tNs: number;
  bus: number;
  address: number;
  direction: 'read' | 'write';
  requestedLength: number;
  bytes: number[];
  reply: number[];
  status: TransactionStatus;
}

export interface SpiTransaction {
  id: number;
  tNs: number;
  bus: number;
  cs: number;
  mosi: number[];
  miso: number[];
  status: TransactionStatus;
}

export type UartLineEnding = 'none' | 'lf' | 'cr' | 'crlf';

export interface UartChunk {
  id: number;
  tNs: number;
  port: number;
  direction: 'tx' | 'rx';
  bytes: number[];
  text: string;
  lineEnding: UartLineEnding;
}

export interface ProtocolInspectorOptions {
  maxEntries?: number;
  maxUartBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_UART_BYTES = 4096;

function boundedLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.max(1, Math.floor(value!)) : fallback;
}

function normalizeByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const byte = Math.trunc(value) % 256;
  return byte < 0 ? byte + 256 : byte;
}

function normalizeBytes(bytes: number[]): number[] {
  return bytes.map(normalizeByte);
}

function normalizeTime(t: number): number {
  return Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0;
}

function parseAddress(address: string): number {
  const trimmed = address.trim().toLowerCase();
  const parsed = trimmed.startsWith('0x')
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(0x7f, parsed)) : 0;
}

function lineEnding(bytes: number[]): UartLineEnding {
  if (bytes.length >= 2 && bytes.at(-2) === 13 && bytes.at(-1) === 10) return 'crlf';
  if (bytes.at(-1) === 10) return 'lf';
  if (bytes.at(-1) === 13) return 'cr';
  return 'none';
}

function displayText(bytes: number[]): string {
  return bytes
    .map((byte) => {
      if (byte === 10) return '\\n';
      if (byte === 13) return '\\r';
      if (byte === 9) return '\\t';
      return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
    })
    .join('');
}

function trimEntries<T>(entries: T[], limit: number): void {
  if (entries.length > limit) entries.splice(0, entries.length - limit);
}

export function formatHexBytes(bytes: readonly number[]): string {
  if (!bytes.length) return '—';
  return bytes
    .map((byte) => normalizeByte(byte).toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

export function formatI2cAddress(address: number): string {
  const normalized = Number.isFinite(address)
    ? Math.max(0, Math.min(0x7f, Math.trunc(address)))
    : 0;
  return `0x${normalized.toString(16).padStart(2, '0').toUpperCase()}`;
}

export class ProtocolInspector {
  private readonly maxEntries: number;
  private readonly maxUartBytes: number;
  private readonly i2c: I2cTransaction[] = [];
  private readonly spi: SpiTransaction[] = [];
  private readonly uart: UartChunk[] = [];
  private nextId = 1;
  private uartBytes = 0;

  unmatchedReplies = 0;
  droppedUartBytes = 0;

  constructor(options: ProtocolInspectorOptions = {}) {
    this.maxEntries = boundedLimit(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxUartBytes = boundedLimit(options.maxUartBytes, DEFAULT_MAX_UART_BYTES);
  }

  ingest(input: ProtocolInput): void {
    switch (input.type) {
      case 'i2c_write': {
        const bytes = normalizeBytes(input.bytes);
        this.i2c.push({
          id: this.nextId++,
          tNs: normalizeTime(input.t),
          bus: input.bus,
          address: parseAddress(input.address),
          direction: 'write',
          requestedLength: bytes.length,
          bytes,
          reply: [],
          status: 'complete',
        });
        trimEntries(this.i2c, this.maxEntries);
        break;
      }
      case 'i2c_read': {
        const length = Number.isFinite(input.length) ? Math.max(0, Math.floor(input.length)) : 0;
        this.i2c.push({
          id: this.nextId++,
          tNs: normalizeTime(input.t),
          bus: input.bus,
          address: parseAddress(input.address),
          direction: 'read',
          requestedLength: length,
          bytes: [],
          reply: [],
          status: 'pending',
        });
        trimEntries(this.i2c, this.maxEntries);
        break;
      }
      case 'i2c_slave_reply':
        this.completeI2cRead(input);
        break;
      case 'spi_transfer':
        this.spi.push({
          id: this.nextId++,
          tNs: normalizeTime(input.t),
          bus: input.bus,
          cs: input.cs,
          mosi: normalizeBytes(input.mosi),
          miso: [],
          status: 'pending',
        });
        trimEntries(this.spi, this.maxEntries);
        break;
      case 'spi_miso':
        this.completeSpiTransfer(input);
        break;
      case 'uart_tx':
        this.pushUart(input.t, input.port, 'tx', input.bytes);
        break;
      case 'uart_rx':
        this.pushUart(input.t, input.port, 'rx', input.bytes);
        break;
      default:
        break;
    }
  }

  i2cTransactions(): I2cTransaction[] {
    return this.i2c.map((entry) => ({
      ...entry,
      bytes: [...entry.bytes],
      reply: [...entry.reply],
    }));
  }

  spiTransactions(): SpiTransaction[] {
    return this.spi.map((entry) => ({ ...entry, mosi: [...entry.mosi], miso: [...entry.miso] }));
  }

  uartChunks(): UartChunk[] {
    return this.uart.map((entry) => ({ ...entry, bytes: [...entry.bytes] }));
  }

  clear(): void {
    this.i2c.length = 0;
    this.spi.length = 0;
    this.uart.length = 0;
    this.uartBytes = 0;
    this.unmatchedReplies = 0;
    this.droppedUartBytes = 0;
  }

  private completeI2cRead(input: Extract<BridgeInput, { type: 'i2c_slave_reply' }>): void {
    const address = parseAddress(input.address);
    const transaction = [...this.i2c]
      .reverse()
      .find(
        (entry) =>
          entry.direction === 'read' &&
          entry.status === 'pending' &&
          entry.bus === input.bus &&
          entry.address === address,
      );
    if (!transaction) {
      this.unmatchedReplies++;
      return;
    }
    transaction.reply = normalizeBytes(input.bytes);
    transaction.status =
      transaction.reply.length === transaction.requestedLength ? 'complete' : 'partial';
  }

  private completeSpiTransfer(input: Extract<BridgeInput, { type: 'spi_miso' }>): void {
    const transaction = [...this.spi]
      .reverse()
      .find(
        (entry) => entry.status === 'pending' && entry.bus === input.bus && entry.cs === input.cs,
      );
    if (!transaction) {
      this.unmatchedReplies++;
      return;
    }
    transaction.miso = normalizeBytes(input.miso);
    transaction.status =
      transaction.miso.length === transaction.mosi.length ? 'complete' : 'partial';
  }

  private pushUart(t: number, port: number, direction: 'tx' | 'rx', source: number[]): void {
    const bytes = normalizeBytes(source);
    const chunk: UartChunk = {
      id: this.nextId++,
      tNs: normalizeTime(t),
      port,
      direction,
      bytes,
      text: displayText(bytes),
      lineEnding: lineEnding(bytes),
    };
    this.uart.push(chunk);
    this.uartBytes += bytes.length;

    while (this.uart.length > this.maxEntries) this.dropWholeUartChunk();
    while (this.uartBytes > this.maxUartBytes && this.uart.length) {
      const overflow = this.uartBytes - this.maxUartBytes;
      const first = this.uart[0]!;
      if (first.bytes.length <= overflow) {
        this.dropWholeUartChunk();
      } else {
        first.bytes.splice(0, overflow);
        first.text = displayText(first.bytes);
        first.lineEnding = lineEnding(first.bytes);
        this.uartBytes -= overflow;
        this.droppedUartBytes += overflow;
      }
    }
  }

  private dropWholeUartChunk(): void {
    const removed = this.uart.shift();
    if (!removed) return;
    this.uartBytes -= removed.bytes.length;
    this.droppedUartBytes += removed.bytes.length;
  }
}
