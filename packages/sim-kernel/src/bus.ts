/**
 * Protocol Bus Engines — REFERENCE-SPEC Stage 3. Byte-level transaction models that
 * sit between the emulator (bus master) and slave components, on virtual time.
 *
 * Stage 3 ships the I2C engine in full (multi-device, ACK/NACK, repeated-start,
 * address-conflict + missing-pull-up detection for the ERC) since the gate circuit
 * uses an I2C LCD, plus a minimal SPI mode model. The engine is transport-agnostic:
 * the integration adapts avr8js's TWI/SPI callbacks onto these methods.
 */

/** A slave device attached to the I2C bus at a 7-bit address. */
export interface I2cDevice {
  /** Master addressed us for a write transaction; return true to ACK. */
  startWrite(): boolean;
  /** Master addressed us for a read transaction; return true to ACK. */
  startRead(): boolean;
  /** Master wrote a byte to us; return true to ACK. */
  write(byte: number): boolean;
  /** Master reads a byte from us. */
  read(): number;
  /** Transaction finished (STOP or repeated START). */
  stop(): void;
}

export interface I2cWarning {
  type: 'address-conflict' | 'missing-pullup' | 'no-ack';
  address?: number;
  message: string;
}

/**
 * I2C bus: one master (the MCU) + N slave devices keyed by 7-bit address. Models
 * ACK/NACK, repeated-start and surfaces ERC-relevant warnings. Pure logic — virtual
 * time is the caller's (the kernel advances around it).
 */
export class I2cBus {
  private readonly devices = new Map<number, I2cDevice[]>();
  private active: I2cDevice | null = null;
  private hasPullups = false;
  private readonly warnings: I2cWarning[] = [];

  /** Wire SDA/SCL pull-ups present (required by I2C; absence is an ERC warning). */
  setPullups(present: boolean): void {
    this.hasPullups = present;
  }

  /** Attach a device; two devices at one address is a hard bus conflict (ERC). */
  addDevice(address: number, device: I2cDevice): void {
    if (address < 0 || address > 0x7f) throw new Error(`I2C address out of range: ${address}`);
    const list = this.devices.get(address) ?? [];
    list.push(device);
    this.devices.set(address, list);
    if (list.length > 1) {
      this.warnings.push({
        type: 'address-conflict',
        address,
        message: `two devices share I2C address 0x${address.toString(16)}`,
      });
    }
  }

  /** Addresses with more than one device (bus contention). */
  conflictingAddresses(): number[] {
    return [...this.devices.entries()].filter(([, l]) => l.length > 1).map(([a]) => a);
  }

  get busWarnings(): readonly I2cWarning[] {
    return this.warnings;
  }

  /** START / repeated-START + address + R/W. Returns the ACK bit (true = ACK). */
  connect(address: number, read: boolean): boolean {
    if (!this.hasPullups && this.warnings.every((w) => w.type !== 'missing-pullup')) {
      this.warnings.push({ type: 'missing-pullup', message: 'I2C bus has no pull-up resistors' });
    }
    const list = this.devices.get(address);
    // No device at this address, or an address conflict where no single device can ACK
    // cleanly (contention). `addDevice` always pushes, so a stored list is never empty.
    if (!list || list.length > 1) {
      this.active = null;
      this.warnings.push({
        type: 'no-ack',
        address,
        message: `no device ACKed 0x${address.toString(16)}`,
      });
      return false;
    }
    this.active = list[0]!;
    return read ? this.active.startRead() : this.active.startWrite();
  }

  /** Master writes a byte to the addressed slave; returns the ACK bit. */
  write(byte: number): boolean {
    return this.active ? this.active.write(byte & 0xff) : false;
  }

  /** Master reads a byte from the addressed slave (0xff if none addressed). */
  read(): number {
    return this.active ? this.active.read() & 0xff : 0xff;
  }

  /** STOP / repeated-START — end the current transaction. */
  stop(): void {
    this.active?.stop();
    this.active = null;
  }
}

export type SpiMode = 0 | 1 | 2 | 3;

/** Decompose an SPI mode into (CPOL, CPHA) — REFERENCE-SPEC Stage 3 SPI. */
export function spiModeToCpolCpha(mode: SpiMode): { cpol: 0 | 1; cpha: 0 | 1 } {
  return { cpol: ((mode >> 1) & 1) as 0 | 1, cpha: (mode & 1) as 0 | 1 };
}

/** A slave device on the SPI bus, gated by its own chip-select (CS) line. */
export interface SpiDevice {
  /** True while this device's chip-select is asserted (CS driven LOW). */
  readonly selected: boolean;
  /** Master shifted `mosi` out on MOSI; return the byte to shift back on MISO. */
  transfer(mosi: number): number;
}

/**
 * SPI bus: one master (the MCU) + N slaves, each gated by its own CS pin (unlike I2C's shared address,
 * SPI selects a device by pulling its CS LOW). On every byte the master shifts, the bus routes it to the
 * currently-selected device and returns that device's MISO byte. With no device selected the line reads
 * 0xff (the idle, pulled-up MISO) — exactly what a master sees when it clocks an unselected bus.
 */
export class SpiBus {
  private readonly devices: SpiDevice[] = [];

  addDevice(device: SpiDevice): void {
    this.devices.push(device);
  }

  /** Route one byte to the selected device; returns its MISO byte (0xff if none is selected). */
  transfer(mosi: number): number {
    const active = this.devices.find((d) => d.selected);
    return active ? active.transfer(mosi & 0xff) & 0xff : 0xff;
  }
}
