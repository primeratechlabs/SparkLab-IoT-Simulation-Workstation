/**
 * Reproducible verification of the real WASM binutils chain (avr-as → avr-ld →
 * avr-objcopy) producing a runnable AVR program on avr8js.
 *
 * The wasm tools live in ci/toolchain-builder/out/binutils/ which is GITIGNORED
 * (multi-GB local build, not committed), so this suite SKIPS when they're absent
 * (e.g. in CI). When present locally it re-runs the full chain end-to-end — this
 * is the committed, re-runnable harness behind the "binutils chain verified" claim.
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
import { parseIntelHex } from './intel-hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', '..', '..', 'ci', 'toolchain-builder', 'out', 'binutils');
const LDSCRIPT = join(here, '..', 'test-fixtures', 'avr5-ld.x');
const enc = new TextEncoder();

const GCC = join(here, '..', '..', '..', 'ci', 'toolchain-builder', 'out', 'gcc');
const SDK = join(
  here,
  '..',
  '..',
  '..',
  'ci',
  'toolchain-builder',
  'out',
  'arduino-avr-core',
  'lib',
);

const haveTools =
  existsSync(join(BIN, 'avr-as')) &&
  existsSync(join(BIN, 'avr-ld')) &&
  existsSync(join(BIN, 'avr-objcopy'));
const haveFullToolchain =
  haveTools && existsSync(join(GCC, 'cc1')) && existsSync(join(SDK, 'crtatmega328p.o'));
const SDK_ROOT = join(here, '..', '..', '..', 'ci', 'toolchain-builder', 'out', 'arduino-avr-core');
const haveArduinoSdk =
  haveFullToolchain &&
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(SDK_ROOT, 'headers', 'core'));

function walkDir(dir: string, base = dir): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkDir(p, base));
    else out.push([relative(base, p), readFileSync(p)]);
  }
  return out;
}

interface EmModule {
  callMain(args: string[]): number | undefined;
  FS: {
    writeFile(p: string, b: Uint8Array): void;
    readFile(p: string): Uint8Array;
    analyzePath(p: string): { exists: boolean };
    mkdirTree(p: string): void;
  };
}

async function runTool(
  modulePath: string,
  args: string[],
  inputs: [string, Uint8Array][],
  outputs: string[],
): Promise<Record<string, Uint8Array>> {
  const createModule = (await import(modulePath)).default as (o: unknown) => Promise<EmModule>;
  const m = await createModule({ noInitialRun: true, print: () => {}, printErr: () => {} });
  for (const [p, b] of inputs) {
    const dir = p.slice(0, p.lastIndexOf('/'));
    if (dir)
      try {
        m.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
    m.FS.writeFile(p, b);
  }
  try {
    m.callMain(args);
  } catch (e) {
    if (!(e && typeof e === 'object' && 'status' in e)) throw e;
  }
  const out: Record<string, Uint8Array> = {};
  for (const p of outputs) if (m.FS.analyzePath(p).exists) out[p] = m.FS.readFile(p);
  return out;
}

function runHexOnAvr8js(hexText: string, instructions: number): number {
  const { bytes } = parseIntelHex(hexText);
  const cpu = new CPU(new Uint16Array(bytes.buffer));
  const portB = new AVRIOPort(cpu, portBConfig);
  let toggles = 0;
  let last = 0;
  portB.addListener((v) => {
    const b = (v >> 5) & 1;
    if (b !== last) {
      last = b;
      toggles++;
    }
  });
  for (let i = 0; i < instructions; i++) {
    avrInstruction(cpu);
    cpu.tick();
  }
  return toggles;
}

/** Run firmware that uses the LED + Serial; stop early once enough has happened. */
function runSketchOnAvr8js(
  hexText: string,
  maxInstructions: number,
): { toggles: number; serial: string } {
  const { bytes } = parseIntelHex(hexText);
  const cpu = new CPU(new Uint16Array(bytes.buffer));
  const portB = new AVRIOPort(cpu, portBConfig);
  new AVRTimer(cpu, timer0Config); // millis()/delay() needs timer0
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
  for (let i = 0; i < maxInstructions && !(toggles >= 3 && serial.includes('off')); i++) {
    avrInstruction(cpu);
    cpu.tick();
  }
  return { toggles, serial };
}

describe.skipIf(!haveTools)('WASM binutils chain (real tools, local-only)', () => {
  it('assembles → links → objcopies an AVR program that runs on avr8js', async () => {
    const asm =
      '\t.text\n\t.global __start\n__start:\n\tldi r16,0x20\n\tout 0x04,r16\n\tclr r17\n.L:\n\tout 0x05,r16\n\tout 0x05,r17\n\trjmp .L\n';
    const o = await runTool(
      join(BIN, 'avr-as'),
      ['-mmcu=avr5', '-o', '/b.o', '/b.s'],
      [['/b.s', enc.encode(asm)]],
      ['/b.o'],
    );
    expect(o['/b.o']!.length).toBeGreaterThan(0);

    const ld = await runTool(
      join(BIN, 'avr-ld'),
      ['-m', 'avr5', '-T', '/s.x', '-e', '__start', '-o', '/b.elf', '/b.o'],
      [
        ['/b.o', o['/b.o']!],
        ['/s.x', readFileSync(LDSCRIPT)],
      ],
      ['/b.elf'],
    );
    expect(Array.from(ld['/b.elf']!.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]); // ELF magic

    const oc = await runTool(
      join(BIN, 'avr-objcopy'),
      ['-O', 'ihex', '/b.elf', '/b.hex'],
      [['/b.elf', ld['/b.elf']!]],
      ['/b.hex'],
    );
    expect(runHexOnAvr8js(new TextDecoder().decode(oc['/b.hex']!), 5000)).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(!haveFullToolchain)(
  'FULL WASM compile chain cc1→as→ld→objcopy (real tools)',
  () => {
    it('compiles C → links with crt+libc+libgcc → runs a blinking program on avr8js', async () => {
      const c =
        '#define DDRB (*(volatile unsigned char*)0x24)\n' +
        '#define PORTB (*(volatile unsigned char*)0x25)\n' +
        'int main(void){ DDRB=0x20; for(;;){ PORTB=0x20; for(volatile long i=0;i<2000;i++); PORTB=0; for(volatile long i=0;i<2000;i++); } }\n';

      const s = await runTool(
        join(GCC, 'cc1'),
        ['-quiet', '-mmcu=avr5', '-Os', '/in.c', '-o', '/in.s'],
        [['/in.c', enc.encode(c)]],
        ['/in.s'],
      );
      expect(s['/in.s']!.length).toBeGreaterThan(0);

      const o = await runTool(
        join(BIN, 'avr-as'),
        ['-mmcu=avr5', '-o', '/in.o', '/in.s'],
        [['/in.s', s['/in.s']!]],
        ['/in.o'],
      );
      expect(o['/in.o']!.length).toBeGreaterThan(0);

      const elf = await runTool(
        join(BIN, 'avr-ld'),
        [
          '-m',
          'avr5',
          '-T',
          '/s.x',
          '-o',
          '/blink.elf',
          '/crt.o',
          '/in.o',
          '-L/lib',
          '--start-group',
          '-lgcc',
          '-lm',
          '-lc',
          '-latmega328p',
          '--end-group',
        ],
        [
          ['/crt.o', readFileSync(join(SDK, 'crtatmega328p.o'))],
          ['/in.o', o['/in.o']!],
          ['/s.x', readFileSync(LDSCRIPT)],
          ['/lib/libgcc.a', readFileSync(join(SDK, 'avr5', 'libgcc.a'))],
          ['/lib/libm.a', readFileSync(join(SDK, 'avr5', 'libm.a'))],
          ['/lib/libc.a', readFileSync(join(SDK, 'avr5', 'libc.a'))],
          ['/lib/libatmega328p.a', readFileSync(join(SDK, 'avr5', 'libatmega328p.a'))],
        ],
        ['/blink.elf'],
      );
      expect(Array.from(elf['/blink.elf']!.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]);

      const hex = await runTool(
        join(BIN, 'avr-objcopy'),
        ['-O', 'ihex', '/blink.elf', '/blink.hex'],
        [['/blink.elf', elf['/blink.elf']!]],
        ['/blink.hex'],
      );
      expect(runHexOnAvr8js(new TextDecoder().decode(hex['/blink.hex']!), 200_000)).toBeGreaterThan(
        0,
      );
    }, 60_000);
  },
);

describe.skipIf(!haveArduinoSdk)(
  'REAL Arduino sketch compiled client-side (cc1plus + core.a)',
  () => {
    it('compiles a Blink.ino (Arduino.h/Serial/pinMode) → runs LED + Serial on avr8js', async () => {
      const cpp =
        '#include <Arduino.h>\n' +
        'void setup(){ pinMode(LED_BUILTIN, OUTPUT); Serial.begin(9600); }\n' +
        'void loop(){ digitalWrite(LED_BUILTIN, HIGH); Serial.println("on"); delay(1000); ' +
        'digitalWrite(LED_BUILTIN, LOW); Serial.println("off"); delay(1000); }\n';

      // SDK headers mounted into the compiler's MEMFS (core/variant via -I, avr-libc/gcc via -isystem).
      const headerInputs: [string, Uint8Array][] = [
        ...walkDir(join(SDK_ROOT, 'headers', 'core')).map(([p, b]): [string, Uint8Array] => [
          `/sdk/core/${p}`,
          b,
        ]),
        ...walkDir(join(SDK_ROOT, 'headers', 'variant')).map(([p, b]): [string, Uint8Array] => [
          `/sdk/variant/${p}`,
          b,
        ]),
        ...walkDir(join(SDK_ROOT, 'headers', 'avr-libc')).map(([p, b]): [string, Uint8Array] => [
          `/sdk/avr-libc/${p}`,
          b,
        ]),
        ...walkDir(join(SDK_ROOT, 'headers', 'gcc')).map(([p, b]): [string, Uint8Array] => [
          `/sdk/gcc/${p}`,
          b,
        ]),
      ];
      const cc1Flags = [
        '-quiet',
        '-D__AVR_ATmega328P__',
        '-D__AVR_DEVICE_NAME__=atmega328p',
        '-DF_CPU=16000000L',
        '-DARDUINO=10808',
        '-DARDUINO_AVR_UNO',
        '-DARDUINO_ARCH_AVR',
        '-I/sdk/core',
        '-I/sdk/variant',
        '-isystem',
        '/sdk/avr-libc',
        '-isystem',
        '/sdk/gcc',
        '-mmcu=avr5',
        '-Os',
        '-std=gnu++11',
        '-fno-exceptions',
        '-fno-rtti',
        '-fno-threadsafe-statics',
        '-ffunction-sections',
        '-fdata-sections',
        '/in.cpp',
        '-o',
        '/out.s',
      ];
      const s = await runTool(
        join(GCC, 'cc1plus'),
        cc1Flags,
        [['/in.cpp', enc.encode(cpp)], ...headerInputs],
        ['/out.s'],
      );
      expect(s['/out.s']!.length).toBeGreaterThan(0);

      const o = await runTool(
        join(BIN, 'avr-as'),
        ['-mmcu=avr5', '-o', '/s.o', '/s.s'],
        [['/s.s', s['/out.s']!]],
        ['/s.o'],
      );

      const libDir = join(SDK_ROOT, 'lib');
      const elf = await runTool(
        join(BIN, 'avr-ld'),
        [
          '-m',
          'avr5',
          '-T',
          '/avr5.x',
          '-Tdata',
          '0x800100',
          '--gc-sections',
          '-o',
          '/b.elf',
          '/crt.o',
          '/s.o',
          '-L/lib',
          '--start-group',
          '/core.a',
          '-lgcc',
          '-lm',
          '-lc',
          '-latmega328p',
          '--end-group',
        ],
        [
          ['/crt.o', readFileSync(join(libDir, 'crtatmega328p.o'))],
          ['/s.o', o['/s.o']!],
          ['/core.a', readFileSync(join(libDir, 'core.a'))],
          ['/avr5.x', readFileSync(LDSCRIPT)],
          ['/lib/libgcc.a', readFileSync(join(libDir, 'avr5', 'libgcc.a'))],
          ['/lib/libm.a', readFileSync(join(libDir, 'avr5', 'libm.a'))],
          ['/lib/libc.a', readFileSync(join(libDir, 'avr5', 'libc.a'))],
          ['/lib/libatmega328p.a', readFileSync(join(libDir, 'avr5', 'libatmega328p.a'))],
        ],
        ['/b.elf'],
      );
      expect(Array.from(elf['/b.elf']!.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]);

      const hex = await runTool(
        join(BIN, 'avr-objcopy'),
        ['-O', 'ihex', '/b.elf', '/b.hex'],
        [['/b.elf', elf['/b.elf']!]],
        ['/b.hex'],
      );
      const { toggles, serial } = runSketchOnAvr8js(
        new TextDecoder().decode(hex['/b.hex']!),
        50_000_000,
      );
      expect(toggles).toBeGreaterThanOrEqual(2); // LED blinks
      expect(serial).toContain('on'); // Serial.println works
      expect(serial).toContain('off');
    }, 120_000);
  },
);
