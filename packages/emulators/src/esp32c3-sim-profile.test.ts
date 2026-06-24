/**
 * STAGE 4 GATE #1 (sim build profile, §22) — the full ESP32-C3 vertical, client-side:
 *   real Arduino sketch  --wasm clang-->  object
 *   sim runtime (HAL+crt0) --wasm clang--> object
 *   both                 --wasm lld-->    firmware ELF
 *   firmware             --Rv32Cpu-->     runs, GPIO/timer MMIO observed
 *
 * The sketch is compiled UNCHANGED against the real arduino-esp32 headers and linked against
 * the Arduino HAL shim (pinMode/digitalWrite/delay backed by emulator MMIO) instead of the
 * full IDF — the doctrine's API->HAL bridge. backend_compile_count stays 0 (invariant I8);
 * delay() is virtual-time, so the blink cadence is host-speed independent (I3).
 *
 * Skips when the (gitignored, [CI/HUMAN]) wasm toolchain / SDK build tree is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { LcdI2c } from '@sparklab/components-core';
import { Rv32Cpu, SimpleBus, Rv32Trap } from './rv32.js';
import {
  C3Gpio,
  C3Uart,
  C3I2c,
  C3SysTimer,
  C3_GPIO_BASE,
  C3_UART0_BASE,
  C3_I2C0_BASE,
  C3_SYSTIMER_BASE,
} from './esp32c3-soc.js';
import { MonitoredBus, runWithIdleSkip } from './idle-skip.js';
import { elfLoad } from './elf-load.js';
import { Rv32Runner } from './rv32-runner.js';
import { buildC3Firmware } from '@sparklab/build-orchestrator';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const BUILD = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const WASM_OUT = join(BUILD, 'wasm-out');
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const fixtures = join(here, '..', '..', 'toolchain-loader', 'src', '__fixtures__');
const manifestPath = join(fixtures, 'c3-blink-sdk-manifest.txt');
const i2cManifestPath = join(fixtures, 'c3-i2c-sdk-manifest.txt');
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const PKG = join(BUILD, 'arduino-data', 'packages', 'esp32');
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  existsSync(join(PKG, 'tools', 'esp-rv32', '2601'));
const i2cReady = ready && existsSync(i2cManifestPath);

const GCC = join(PKG, 'tools', 'esp-rv32', '2601');
const C3 = join(PKG, 'tools', 'esp32c3-libs', '3.3.10');
const CORE = join(PKG, 'hardware', 'esp32', '3.3.10');
const CXX = `${GCC}/riscv32-esp-elf/include/c++/14.2.0`;

/** clang flags that make the WASM clang use the gcc newlib + libstdc++ headers (ABI-gate verified). */
const headerEnv = [
  `--gcc-toolchain=${GCC}`,
  `--sysroot=${GCC}/riscv32-esp-elf`,
  '-stdlib=libstdc++',
  '-nobuiltininc',
  '-isystem',
  `${GCC}/lib/gcc/riscv32-esp-elf/14.2.0/include`,
  '-isystem',
  CXX,
  '-isystem',
  `${CXX}/riscv32-esp-elf/rv32imc_zicsr_zifencei/ilp32`,
  '-isystem',
  `${CXX}/backward`,
  '-isystem',
  `${GCC}/riscv32-esp-elf/include`,
];
const target = ['--target=riscv32-esp-elf', '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'];

function sketchArgs(extraIncludes: string[] = []): string[] {
  return [
    ...target,
    ...headerEnv,
    '-Qunused-arguments',
    '-w',
    '-c',
    '-Os',
    '-fno-rtti',
    '-fno-exceptions',
    '-ffunction-sections',
    '-fdata-sections',
    '-std=gnu++2a',
    '-DF_CPU=160000000L',
    '-DARDUINO=10607',
    '-DARDUINO_ESP32C3_DEV',
    '-DARDUINO_ARCH_ESP32',
    '-DESP32=ESP32',
    '-DARDUINO_USB_MODE=1',
    '-DARDUINO_USB_CDC_ON_BOOT=0',
    '-DCORE_DEBUG_LEVEL=0',
    `@${C3}/flags/defines`,
    '-iprefix',
    `${C3}/include/`,
    `@${C3}/flags/includes`,
    `-I${C3}/qio_qspi/include`,
    `-I${CORE}/cores/esp32`,
    `-I${CORE}/variants/esp32c3`,
    ...extraIncludes,
  ];
}
function runtimeArgs(): string[] {
  // freestanding C++; no #include in the shim, so no SDK headers needed.
  return [
    ...target,
    '-nostdlib',
    '-ffreestanding',
    '-ffunction-sections',
    '-fdata-sections',
    '-fno-exceptions',
    '-fno-rtti',
    '-std=gnu++2a',
    '-Os',
    '-c',
  ];
}
function sdkBundle(manifest = manifestPath): ToolInput[] {
  const entries = readFileSync(manifest, 'utf8').split('\n').filter(Boolean);
  return entries.map((rel) => ({
    path: join(BUILD, rel),
    bytes: new Uint8Array(readFileSync(join(BUILD, rel))),
  }));
}
async function buildFirmware(
  tc: WasmRiscvToolchain,
  sketch: string,
  args: string[],
  sdk: ToolInput[],
): Promise<Uint8Array> {
  const sk = await tc.compile({ args, sdk, sourcePath: '/sketch/app.cpp', sourceBytes: sketch });
  expect(sk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const rt = await tc.compile({
    args: runtimeArgs(),
    sdk: [],
    sourcePath: '/rt.cpp',
    sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
  });
  expect(rt.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const lk = await tc.link({
    args: ['-Ttext=0', '-e', '_start', '--gc-sections', '/sketch.o', '/rt.o'],
    inputs: [
      { path: '/sketch.o', bytes: sk.object },
      { path: '/rt.o', bytes: rt.object },
    ],
    outPath: '/fw.elf',
  });
  expect(lk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return lk.output;
}

/** Parse PT_LOAD segments + entry from a little-endian ELF32. */
/** Local adapter to the promoted `elfLoad` (the inline `segs` field name is kept for the other cases). */
function elfLoadSegs(elf: Uint8Array): {
  entry: number;
  segs: { addr: number; data: Uint8Array }[];
} {
  const { entry, segments } = elfLoad(elf);
  return { entry, segs: segments };
}

describe.skipIf(!ready)(
  'Stage 4 gate #1 — client-built C3 sketch runs on the emulator (sim profile)',
  () => {
    it('compiles + links a USER-uploaded library on C3 (header mounted in the SDK, source linked)', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const enc = new TextEncoder();
      const inc = '/userlib/MyMath';
      // Mirrors the build worker: the uploaded library's header mounts in the SDK + its source compiles
      // + links. The sketch #includes it and calls a function defined only in the uploaded source.
      const sketch =
        '#include <Arduino.h>\n#include <MyMath.h>\nvoid setup(){ Serial.begin(115200); Serial.println(myDouble(21)); }\nvoid loop(){}\n';
      const built = await buildC3Firmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
        sdk: [
          ...sdkBundle(),
          { path: `${inc}/MyMath.h`, bytes: enc.encode('#pragma once\nint myDouble(int x);\n') },
        ],
        root: BUILD,
        libraries: [
          {
            includePath: inc,
            sources: [
              {
                path: `${inc}/MyMath.cpp`,
                bytes: enc.encode('#include "MyMath.h"\nint myDouble(int x){ return x * 2; }\n'),
                language: 'c++',
              },
            ],
          },
        ],
      });
      expect(built.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(built.ok).toBe(true);
      expect([built.elf![0], built.elf![1], built.elf![2], built.elf![3]]).toEqual([
        0x7f, 0x45, 0x4c, 0x46,
      ]);
    }, 180000);

    it('compiles the real Arduino blink+Serial sketch, links the HAL shim, observes GPIO8 + Serial (I8 + I3)', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      // 1–3) the REAL C3 sketch (GPIO blink + Serial) → firmware ELF, via the shared portable build core
      const sketch =
        '#include <Arduino.h>\nvoid setup(){ pinMode(8, OUTPUT); Serial.begin(115200); }\n' +
        'void loop(){ digitalWrite(8, HIGH); Serial.println("on"); delay(5); digitalWrite(8, LOW); delay(5); }\n';
      const runtimeSource = new Uint8Array(readFileSync(runtimeCpp));
      const built = await buildC3Firmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource,
        sdk: sdkBundle(),
        root: BUILD,
      });
      expect(built.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(built.ok).toBe(true);
      const elf = built.elf!;
      expect([elf[0], elf[1], elf[2], elf[3]]).toEqual([0x7f, 0x45, 0x4c, 0x46]);

      // gate #5: rebuilding the same sketch yields a byte-identical firmware (reproducible build, I5)
      const rebuilt = await buildC3Firmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource,
        sdk: sdkBundle(),
        root: BUILD,
      });
      expect(Array.from(rebuilt.elf!)).toEqual(Array.from(elf));

      // 4) run the firmware on the rv32 emulator via Rv32Runner (the worker-shaped seam)
      const runner = new Rv32Runner(elf);
      const trace: Array<0 | 1> = [];
      runner.gpio.onChange = (pin, level) => {
        runner.pins[pin] = level;
        if (pin === 8) trace.push(level);
      };
      // bound the run; loop() runs forever, so advance virtual time (executeForMillis) until a few blinks
      for (let ms = 0; ms < 4000 && trace.length < 6; ms += 20) runner.executeForMillis(20);

      // setup() enabled GPIO8 output; loop() toggles it HIGH/LOW each iteration
      expect(runner.gpio.enable & (1 << 8)).toBeTruthy();
      expect(trace.length).toBeGreaterThanOrEqual(4);
      expect(trace.slice(0, 4)).toEqual([1, 0, 1, 0]); // HIGH, LOW, HIGH, LOW …
      expect(runner.pins[8]).toBeDefined(); // the worker reflects GPIO8 from runner.pins
      // Serial.println("on") ran each loop → the UART captured "on\r\n" repeated
      expect(runner.serial()).toContain('on\r\n');
      expect(runner.serial().match(/on/g)!.length).toBeGreaterThanOrEqual(2);
      expect(runner.virtualTimeNs).toBeGreaterThan(0);
    }, 180000);

    it('Stage 7: idle-skip fast-forwards the REAL delay() byte-identically, in far fewer steps', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const sketch =
        '#include <Arduino.h>\nvoid setup(){ pinMode(8, OUTPUT); Serial.begin(115200); }\n' +
        'void loop(){ digitalWrite(8, HIGH); Serial.println("on"); delay(5); digitalWrite(8, LOW); delay(5); }\n';
      const fw = await buildFirmware(tc, sketch, sketchArgs(), sdkBundle());
      const { entry, segs } = elfLoadSegs(fw);

      // build a fresh CPU + peripherals; optionally over a MonitoredBus for idle-skip
      const make = (monitored: boolean) => {
        const inner = new SimpleBus(new Uint8Array(0x40000));
        const gpio = new C3Gpio();
        const uart = new C3Uart();
        const trace: Array<0 | 1> = [];
        gpio.onChange = (pin, level) => {
          if (pin === 8) trace.push(level);
        };
        const mbus = monitored ? new MonitoredBus(inner, C3_SYSTIMER_BASE) : null;
        const cpu = new Rv32Cpu(mbus ?? inner);
        inner.map(C3_UART0_BASE, 0x80, uart);
        inner.map(C3_GPIO_BASE, 0x800, gpio);
        inner.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
        for (const s of segs) inner.ram.set(s.data, s.addr);
        cpu.pc = entry;
        cpu.setReg(2, 0x30000);
        return { cpu, gpio, uart, trace, mbus };
      };

      // plain run — every instruction
      const p = make(false);
      let plainSteps = 0;
      for (; plainSteps < 5_000_000 && p.trace.length < 6; plainSteps++) {
        try {
          p.cpu.step();
        } catch (e) {
          if (e instanceof Rv32Trap) break;
          throw e;
        }
      }

      // idle-skip run — elide the delay() spins
      const s = make(true);
      const res = runWithIdleSkip(s.cpu, s.mbus!, {
        millisAddr: C3_SYSTIMER_BASE,
        cyclesPerMs: 50,
        maxSteps: 5_000_000,
        stopWhen: () => s.trace.length >= 6,
      });

      expect(s.trace.slice(0, 6)).toEqual(p.trace.slice(0, 6)); // identical GPIO waveform
      expect(s.uart.text()).toBe(p.uart.text()); // identical Serial output
      expect(res.skippedCycles).toBeGreaterThan(0); // delay() spins were fast-forwarded
      expect(res.steps).toBeLessThan(plainSteps); // fewer real instructions executed
    }, 180000);
  },
);

describe.skipIf(!i2cReady)(
  'Stage 4 gate #1 — client-built C3 I2C-LCD sketch drives the display (sim profile)',
  () => {
    it('compiles a Wire sketch, links the I2C HAL shim, and the PCF8574 LCD shows the text', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      // real sketch driving a 16x2 I2C LCD (PCF8574 backpack @ 0x27) over Wire, in HD44780 4-bit
      const sketch =
        '#include <Arduino.h>\n#include <Wire.h>\n' +
        'static void pcf(unsigned char b){ Wire.beginTransmission(0x27); Wire.write(b); Wire.endTransmission(); }\n' +
        'static void nib(unsigned char d, unsigned char rs){ unsigned char b=(d&0xF0)|rs|0x08; pcf(b|0x04); pcf(b); }\n' +
        'static void ch(char c){ nib(c&0xF0,1); nib(c<<4,1); }\n' +
        "void setup(){ Wire.begin(); ch('H'); ch('i'); }\nvoid loop(){}\n";
      const libs = join(CORE, 'libraries');
      const fw = await buildFirmware(
        tc,
        sketch,
        sketchArgs([`-I${libs}/Wire/src`]),
        sdkBundle(i2cManifestPath),
      );
      expect([fw[0], fw[1], fw[2], fw[3]]).toEqual([0x7f, 0x45, 0x4c, 0x46]);

      // run with the I2C controller + a PCF8574/HD44780 LCD (reused from components-core) @ 0x27
      const { entry, segs } = elfLoadSegs(fw);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const i2c = new C3I2c();
      const lcd = new LcdI2c('lcd1', 0x27);
      i2c.attach(0x27, lcd);
      bus.map(C3_I2C0_BASE, 0x20, i2c);
      for (const s of segs) bus.ram.set(s.data, s.addr);
      const cpu = new Rv32Cpu(bus);
      cpu.pc = entry;
      cpu.setReg(2, 0x30000);

      for (let k = 0; k < 5_000_000 && lcd.text.length < 2; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof Rv32Trap) break;
          throw e;
        }
      }

      // the bytes the sketch sent over Wire, decoded by the LCD, spell what it "printed"
      expect(lcd.text).toBe('Hi');
      expect(lcd.bytes).toBeGreaterThan(0);
    }, 180000);
  },
);
