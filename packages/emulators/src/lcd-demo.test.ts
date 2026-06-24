/**
 * External-library showcase that's observable WITHOUT a timing-critical sensor:
 * an I2C 16x2 LCD via the LiquidCrystal_I2C library (which uses the bundled Wire
 * library — Wire.cpp C++ AND utility/twi.c C). All sources compile 100% client-side
 * (WasmAvrToolchain, cc1plus + cc1). The firmware runs on avr8js; a virtual PCF8574
 * + HD44780 model captures the I2C traffic and reconstructs the text the sketch
 * "displays" on the LCD. Skips in CI (gitignored toolchain + local libraries).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  CPU,
  avrInstruction,
  AVRTWI,
  twiConfig,
  AVRUSART,
  usart0Config,
  AVRTimer,
  timer0Config,
  type TWIEventHandler,
} from 'avr8js';
import {
  WasmAvrToolchain,
  type AvrSdk,
  type SdkFile,
  type EmscriptenModuleFactory,
} from '@sparklab/toolchain-loader';
import { parseIntelHex } from './intel-hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const LCD = join(REPO, '.tools', 'arduino-user', 'libraries', 'LiquidCrystal_I2C');
const WIRE = join(
  REPO,
  '.tools',
  'arduino15',
  'packages',
  'arduino',
  'hardware',
  'avr',
  '1.8.8',
  'libraries',
  'Wire',
  'src',
);
const LDSCRIPT = join(here, '..', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(GCC, 'cc1')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(LCD, 'LiquidCrystal_I2C.cpp')) &&
  existsSync(join(WIRE, 'Wire.cpp')) &&
  existsSync(join(WIRE, 'utility', 'twi.c'));

const enc = new TextEncoder();
const factory = async (p: string): Promise<EmscriptenModuleFactory> =>
  (await import(p)).default as EmscriptenModuleFactory;
function walk(dir: string, base = dir): SdkFile[] {
  const out: SdkFile[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push({ path: relative(base, p), bytes: readFileSync(p) });
  }
  return out;
}

/**
 * Virtual I2C LCD: a PCF8574 expander (addr 0x27) feeding an HD44780 in 4-bit mode.
 * Captures every I2C byte; latches the data nibble (P4–P7) on each E (P2) falling
 * edge, with RS = P0; reassembles RS=1 nibble pairs into displayed characters.
 */
class VirtualI2cLcd implements TWIEventHandler {
  text = '';
  bytes = 0;
  private addr = 0;
  private writing = false;
  private prevE = 0;
  private pendingHigh: number | null = null;
  constructor(
    private readonly twi: AVRTWI,
    private readonly i2cAddr = 0x27,
  ) {}
  start(): void {
    this.twi.completeStart();
  }
  stop(): void {
    this.twi.completeStop();
  }
  connectToSlave(addr: number, write: boolean): void {
    this.addr = addr;
    this.writing = write;
    this.twi.completeConnect(addr === this.i2cAddr); // ACK only our LCD
  }
  readByte(): void {
    this.twi.completeRead(0xff);
  }
  writeByte(value: number): void {
    this.twi.completeWrite(this.addr === this.i2cAddr);
    if (this.addr !== this.i2cAddr || !this.writing) return;
    this.bytes++;
    const e = (value >> 2) & 1; // P2 = Enable
    if (this.prevE === 1 && e === 0) {
      const nibble = (value >> 4) & 0x0f; // P4–P7 = D4–D7
      const rs = value & 1; // P0 = RS (1 = data/char)
      if (rs === 1) {
        if (this.pendingHigh === null) this.pendingHigh = nibble;
        else {
          this.text += String.fromCharCode((this.pendingHigh << 4) | nibble);
          this.pendingHigh = null;
        }
      } else {
        this.pendingHigh = null; // a command resyncs the nibble pairing
      }
    }
    this.prevE = e;
  }
}

describe.skipIf(!ready)('I2C LCD via LiquidCrystal_I2C + Wire (external libs, C++ and C)', () => {
  it('compiles sketch + library + Wire(C/C++) client-side and "displays" text on a virtual LCD', async () => {
    const libDir = join(SDK_ROOT, 'lib');
    const sdk: AvrSdk = {
      headerMounts: [
        { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
        { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
        { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
        { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
        { mount: '/sdk/wire', files: walk(WIRE) },
        { mount: '/sdk/lcd', files: walk(LCD).filter((f) => f.path.endsWith('.h')) },
      ],
      crt: readFileSync(join(libDir, 'crtatmega328p.o')),
      coreA: readFileSync(join(libDir, 'core.a')),
      libs: ['libgcc.a', 'libm.a', 'libc.a', 'libatmega328p.a'].map((name) => ({
        name,
        bytes: readFileSync(join(libDir, 'avr5', name)),
      })),
      ldscript: readFileSync(LDSCRIPT),
    };
    const tc = new WasmAvrToolchain(
      {
        cc1plus: await factory(join(GCC, 'cc1plus')),
        cc1: await factory(join(GCC, 'cc1')),
        avrAs: await factory(join(BIN, 'avr-as')),
        avrLd: await factory(join(BIN, 'avr-ld')),
      },
      sdk,
    );
    const inc = ['-I/sdk/wire', '-I/sdk/wire/utility', '-I/sdk/lcd'];
    const flags = [
      '-Os',
      '-ffunction-sections',
      '-fdata-sections',
      '-DF_CPU=16000000L',
      '-DARDUINO=10808',
      '-DARDUINO_AVR_UNO',
      '-DARDUINO_ARCH_AVR',
      ...inc,
    ];

    const sketch = `#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup(){ Serial.begin(9600); lcd.init(); lcd.backlight(); lcd.setCursor(0,0); lcd.print("Hello Sparklab"); Serial.println("LCD ready"); }
void loop(){ delay(1000); }`;

    const sources: { key: string; bytes: Uint8Array; language?: 'c' | 'c++' }[] = [
      { key: 'sketch', bytes: enc.encode(sketch) },
      { key: 'lcd', bytes: readFileSync(join(LCD, 'LiquidCrystal_I2C.cpp')) },
      { key: 'wire', bytes: readFileSync(join(WIRE, 'Wire.cpp')) },
      { key: 'twi', bytes: readFileSync(join(WIRE, 'utility', 'twi.c')), language: 'c' },
    ];
    const objs: Uint8Array[] = [];
    for (const s of sources) {
      const r = await tc.compile({
        sourceKey: `sha256:${s.key}`,
        sourceBytes: s.bytes,
        target: 'avr',
        flags,
        includedHeaderHashes: [],
        ...(s.language ? { language: s.language } : {}),
      });
      expect(
        r.diagnostics.filter((d) => d.severity === 'error'),
        `compile ${s.key}`,
      ).toHaveLength(0);
      objs.push(r.object);
    }
    const linked = await tc.link({ objects: objs, target: 'avr', flags: [] });
    expect(linked.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    const oc = await (
      await factory(join(BIN, 'avr-objcopy'))
    )({ noInitialRun: true, print: () => {}, printErr: () => {} });
    oc.FS.writeFile('/b.elf', linked.elf);
    try {
      oc.callMain(['-O', 'ihex', '/b.elf', '/b.hex']);
    } catch (e) {
      if (!(e && typeof e === 'object' && 'status' in e)) throw e;
    }
    const { bytes } = parseIntelHex(new TextDecoder().decode(oc.FS.readFile('/b.hex')));

    // Simulate with the virtual I2C LCD attached to the TWI bus.
    const cpu = new CPU(new Uint16Array(bytes.buffer));
    new AVRTimer(cpu, timer0Config); // delay()/millis()
    const usart = new AVRUSART(cpu, usart0Config, 16_000_000);
    const twi = new AVRTWI(cpu, twiConfig, 16_000_000);
    const lcd = new VirtualI2cLcd(twi, 0x27);
    twi.eventHandler = lcd;
    let serial = '';
    usart.onByteTransmit = (c) => (serial += String.fromCharCode(c));
    for (let i = 0; i < 30_000_000 && !lcd.text.includes('Sparklab'); i++) {
      avrInstruction(cpu);
      cpu.tick();
    }

    console.log('\n----- Virtual I2C LCD (LiquidCrystal_I2C compiled client-side) -----');
    console.log(`  Serial            : "${serial.trim()}"`);
    console.log(`  I2C bytes to 0x27: ${lcd.bytes}`);
    console.log(`  LCD display       : "${lcd.text}"`);

    expect(lcd.bytes).toBeGreaterThan(0); // library drove the I2C bus
    expect(lcd.text).toContain('Hello Sparklab'); // decoded HD44780 text
  }, 120_000);
});
