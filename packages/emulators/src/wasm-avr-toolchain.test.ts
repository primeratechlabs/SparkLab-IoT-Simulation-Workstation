/**
 * Verifies the WasmAvrToolchain DRIVER class (not just raw tool calls): it must
 * compile + link a real Arduino sketch via its Toolchain API into runnable firmware.
 * Skips when the gitignored local toolchain artifacts are absent (CI).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  CPU,
  avrInstruction,
  AVRIOPort,
  portBConfig,
  AVRUSART,
  usart0Config,
  AVRTimer,
  timer0Config,
} from 'avr8js';
import {
  WasmAvrToolchain,
  type AvrSdk,
  type SdkFile,
  type EmscriptenModuleFactory,
} from '@sparklab/toolchain-loader';
import { parseIntelHex } from './intel-hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', '..', 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const LDSCRIPT = join(here, '..', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(BIN, 'avr-as')) &&
  existsSync(join(BIN, 'avr-ld')) &&
  existsSync(join(BIN, 'avr-objcopy')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a'));

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

function loadSdk(): AvrSdk {
  const lib = join(SDK_ROOT, 'lib');
  return {
    headerMounts: [
      { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
      { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
      { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
      { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
    ],
    crt: readFileSync(join(lib, 'crtatmega328p.o')),
    coreA: readFileSync(join(lib, 'core.a')),
    libs: ['libgcc.a', 'libm.a', 'libc.a', 'libatmega328p.a'].map((name) => ({
      name,
      bytes: readFileSync(join(lib, 'avr5', name)),
    })),
    ldscript: readFileSync(LDSCRIPT),
  };
}

/** Raw avr-objcopy ELF→ihex (image-packer's job; here just to feed avr8js). */
async function elfToHex(elf: Uint8Array): Promise<string> {
  const create = await factory(join(BIN, 'avr-objcopy'));
  const m = await create({ noInitialRun: true, print: () => {}, printErr: () => {} });
  m.FS.writeFile('/b.elf', elf);
  try {
    m.callMain(['-O', 'ihex', '/b.elf', '/b.hex']);
  } catch (e) {
    if (!(e && typeof e === 'object' && 'status' in e)) throw e;
  }
  return new TextDecoder().decode(m.FS.readFile('/b.hex'));
}

describe.skipIf(!ready)('WasmAvrToolchain (driver class, real tools)', () => {
  it('compiles + links a Blink sketch into runnable firmware (LED + Serial)', async () => {
    const tc = new WasmAvrToolchain(
      {
        cc1plus: await factory(join(GCC, 'cc1plus')),
        avrAs: await factory(join(BIN, 'avr-as')),
        avrLd: await factory(join(BIN, 'avr-ld')),
      },
      loadSdk(),
    );

    const cpp =
      '#include <Arduino.h>\n' +
      'void setup(){ pinMode(LED_BUILTIN, OUTPUT); Serial.begin(9600); }\n' +
      'void loop(){ digitalWrite(LED_BUILTIN, HIGH); Serial.println("on"); delay(1000); ' +
      'digitalWrite(LED_BUILTIN, LOW); Serial.println("off"); delay(1000); }\n';

    const compiled = await tc.compile({
      sourceKey: 'sha256:blink',
      sourceBytes: enc.encode(cpp),
      target: 'avr-atmega328p',
      flags: [
        '-Os',
        '-ffunction-sections',
        '-fdata-sections',
        '-DF_CPU=16000000L',
        '-DARDUINO=10808',
        '-DARDUINO_AVR_UNO',
        '-DARDUINO_ARCH_AVR',
      ],
      includedHeaderHashes: [],
    });
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(compiled.object.length).toBeGreaterThan(0);

    const linked = await tc.link({
      objects: [compiled.object],
      target: 'avr-atmega328p',
      flags: [],
    });
    expect(linked.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(Array.from(linked.elf.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]);

    const { bytes } = parseIntelHex(await elfToHex(linked.elf));
    const cpu = new CPU(new Uint16Array(bytes.buffer));
    const portB = new AVRIOPort(cpu, portBConfig);
    new AVRTimer(cpu, timer0Config);
    const usart = new AVRUSART(cpu, usart0Config, 16_000_000);
    let toggles = 0;
    let last = 0;
    let serial = '';
    portB.addListener((v) => {
      const b = (v >> 5) & 1;
      if (b !== last) {
        last = b;
        toggles++;
      }
    });
    usart.onByteTransmit = (c) => (serial += String.fromCharCode(c));
    for (let i = 0; i < 50_000_000 && !(toggles >= 3 && serial.includes('off')); i++) {
      avrInstruction(cpu);
      cpu.tick();
    }
    expect(toggles).toBeGreaterThanOrEqual(2);
    expect(serial).toContain('on');
    expect(serial).toContain('off');
  }, 120_000);
});
