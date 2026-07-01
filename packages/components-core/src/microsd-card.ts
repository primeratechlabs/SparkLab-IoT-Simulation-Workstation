import type { CircuitHost, SimComponent } from './sdk.js';
import type { SpiDevice } from '@sparklab/sim-kernel';

const BLOCK = 512;

// ── SD-over-SPI protocol ────────────────────────────────────────────────────────────────────────────
// A command is 6 bytes: [0x40|index, arg31..0 (4 bytes), CRC]. The card replies R1 (bit0 = idle) on the
// following clocks, then — for a read — a 0xFE data token + 512 bytes + 2 CRC; a write is the mirror.
const DATA_TOKEN = 0xfe;

/**
 * microSD card over SPI. It models the real card init handshake (CMD0 → CMD8 → ACMD41 → CMD58) and single-
 * block read (CMD17) / write (CMD24) against an in-memory disk image, so the Arduino `SD` library can
 * mount the volume and read/write files for real. The image is a valid FAT16 super-floppy carrying a
 * sample file; writes persist for the session. Selected by CS; data rides the shared SPI bus.
 */
export class MicroSdCard implements SimComponent, SpiDevice {
  readonly image: Uint8Array;
  private host: CircuitHost | null = null;
  private hasCs = false;
  private csLow = false;
  private rx: number[] = []; // command bytes being collected
  private tx: number[] = []; // bytes queued onto MISO
  private initialized = false;
  private writeBlock = -1; // block being written (CMD24), else -1
  private writeBuf: number[] = [];

  constructor(
    readonly id: string,
    private readonly csPin?: number,
    files: Array<{ name: string; content: string }> = [
      { name: 'README.TXT', content: 'Hello SparkLab\r\n' },
    ],
  ) {
    this.image = buildFat16Image(files);
  }

  attach(host: CircuitHost): void {
    this.host = host;
    host.addSpiDevice(this);
    if (this.csPin !== undefined) {
      this.hasCs = true;
      host.watchPin(this.csPin, (l) => (this.csLow = l === 'low'));
    }
  }

  get selected(): boolean {
    return this.hasCs ? this.csLow : true;
  }

  transfer(mosi: number): number {
    if (!this.selected) return 0xff;
    const out = this.tx.length ? this.tx.shift()! : 0xff; // MISO byte already prepared by prior clocks
    this.process(mosi & 0xff);
    return out;
  }

  private r1(): number {
    return this.initialized ? 0x00 : 0x01; // bit0 = in-idle-state until ACMD41 completes
  }

  private process(b: number): void {
    if (this.writeBlock >= 0) return this.recvWrite(b);
    // Wait for a command-start byte (0b01xxxxxx) before collecting.
    if (this.rx.length === 0 && (b & 0xc0) !== 0x40) return;
    this.rx.push(b);
    if (this.rx.length < 6) return;
    const cmd = this.rx;
    this.rx = [];
    const idx = cmd[0]! & 0x3f;
    const arg = ((cmd[1]! << 24) | (cmd[2]! << 16) | (cmd[3]! << 8) | cmd[4]!) >>> 0;
    this.handle(idx, arg);
  }

  private handle(idx: number, arg: number): void {
    switch (idx) {
      case 0: // GO_IDLE_STATE
        this.tx.push(0xff, 0x01);
        break;
      case 8: // SEND_IF_COND (SDv2): echo the voltage + check pattern
        this.tx.push(0xff, 0x01, 0x00, 0x00, 0x01, 0xaa);
        break;
      case 55: // APP_CMD
        this.tx.push(0xff, this.r1());
        break;
      case 41: // ACMD41: init complete → ready
        this.initialized = true;
        this.tx.push(0xff, 0x00);
        break;
      case 58: // READ_OCR: standard-capacity (CCS=0) → byte addressing
        this.tx.push(0xff, this.r1(), 0x00, 0xff, 0x80, 0x00);
        break;
      case 16: // SET_BLOCKLEN
      case 59: // CRC_ON_OFF
        this.tx.push(0xff, 0x00);
        break;
      case 17: {
        // READ_SINGLE_BLOCK (byte address for standard capacity)
        const blk = Math.floor(arg / BLOCK);
        this.tx.push(0xff, 0x00, DATA_TOKEN);
        for (let i = 0; i < BLOCK; i++) this.tx.push(this.image[blk * BLOCK + i] ?? 0);
        this.tx.push(0xff, 0xff); // CRC
        break;
      }
      case 24: // WRITE_BLOCK: R1, then the host streams the data packet
        this.writeBlock = Math.floor(arg / BLOCK);
        this.writeBuf = [];
        this.tx.push(0xff, 0x00);
        break;
      default:
        this.tx.push(0xff, this.r1()); // accept unmodelled commands
    }
  }

  private recvWrite(b: number): void {
    if (this.writeBuf.length === 0 && b !== DATA_TOKEN) return; // skip until the data token
    this.writeBuf.push(b);
    // token(1) + data(512) + crc(2)
    if (this.writeBuf.length === 1 + BLOCK + 2) {
      const base = this.writeBlock * BLOCK;
      for (let i = 0; i < BLOCK; i++) this.image[base + i] = this.writeBuf[1 + i]!;
      this.writeBlock = -1;
      this.tx.push(0x05, 0x00, 0xff); // data-accepted response + brief busy + ready
    }
  }

  /** Read a 512-byte block straight from the image (test helper). */
  readBlock(block: number): Uint8Array {
    return this.image.slice(block * BLOCK, block * BLOCK + BLOCK);
  }
}

// ── FAT16 super-floppy image builder ──────────────────────────────────────────────────────────────────
const TOTAL_SECTORS = 8192; // 4 MiB — comfortably above the 4085-cluster FAT16 minimum
const RESERVED = 1;
const NUM_FATS = 2;
const ROOT_ENTRIES = 512;
const ROOT_SECTORS = (ROOT_ENTRIES * 32) / BLOCK; // 32
const FAT_SECTORS = 32; // (clusters+2)*2/512 with ~8095 clusters ≈ 32

/** Build a minimal valid FAT16 super-floppy image containing the given files in the root directory. */
export function buildFat16Image(files: Array<{ name: string; content: string }>): Uint8Array {
  const img = new Uint8Array(TOTAL_SECTORS * BLOCK);
  const dv = new DataView(img.buffer);
  const fat1 = RESERVED * BLOCK;
  const fat2 = fat1 + FAT_SECTORS * BLOCK;
  const rootStart = fat2 + FAT_SECTORS * BLOCK;
  const dataStart = rootStart + ROOT_SECTORS * BLOCK; // cluster 2

  // Boot sector (BPB).
  img[0] = 0xeb;
  img[1] = 0x3c;
  img[2] = 0x90;
  writeAscii(img, 3, 'MSDOS5.0');
  dv.setUint16(11, BLOCK, true); // bytes/sector
  img[13] = 1; // sectors/cluster
  dv.setUint16(14, RESERVED, true);
  img[16] = NUM_FATS;
  dv.setUint16(17, ROOT_ENTRIES, true);
  dv.setUint16(19, TOTAL_SECTORS, true); // total sectors (16-bit)
  img[21] = 0xf8; // media descriptor
  dv.setUint16(22, FAT_SECTORS, true); // sectors/FAT
  dv.setUint16(24, 63, true); // sectors/track
  dv.setUint16(26, 255, true); // heads
  img[38] = 0x29; // extended boot signature
  dv.setUint32(39, 0x12345678, true); // volume id
  writeAscii(img, 43, 'SPARKLAB   ');
  writeAscii(img, 54, 'FAT16   ');
  img[510] = 0x55;
  img[511] = 0xaa;

  // FAT: entry 0 = media | 0xFF00, entry 1 = EOC. Each file below claims one cluster (≤512B content).
  const setFat = (cluster: number, value: number): void => {
    dv.setUint16(fat1 + cluster * 2, value, true);
    dv.setUint16(fat2 + cluster * 2, value, true);
  };
  setFat(0, 0xfff8);
  setFat(1, 0xffff);

  let cluster = 2;
  let entry = rootStart;
  const enc = new TextEncoder();
  for (const f of files) {
    const bytes = enc.encode(f.content);
    if (bytes.length > BLOCK) throw new Error('sample file exceeds one cluster'); // keep the builder tiny
    // 8.3 directory entry
    writeAscii(img, entry, fat83Name(f.name));
    img[entry + 11] = 0x20; // archive
    dv.setUint16(entry + 26, cluster, true); // start cluster (low word)
    dv.setUint32(entry + 28, bytes.length, true); // file size
    img.set(bytes, dataStart + (cluster - 2) * BLOCK);
    setFat(cluster, 0xffff); // single-cluster file → EOC
    cluster++;
    entry += 32;
  }
  return img;
}

function writeAscii(img: Uint8Array, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) img[at + i] = s.charCodeAt(i) & 0xff;
}
/** "readme.txt" → the 11-byte padded 8.3 field "README  TXT". */
function fat83Name(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = (dot >= 0 ? name.slice(0, dot) : name).toUpperCase().slice(0, 8).padEnd(8, ' ');
  const ext = (dot >= 0 ? name.slice(dot + 1) : '').toUpperCase().slice(0, 3).padEnd(3, ' ');
  return base + ext;
}
