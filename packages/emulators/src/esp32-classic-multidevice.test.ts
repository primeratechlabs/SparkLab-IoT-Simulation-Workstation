/**
 * STAGE 5 — maximum-complexity ESP32-classic integration, client-side. Proves the Xtensa
 * toolchain + sim profile handle a real multi-device sketch AND an external Arduino library:
 *
 *  (1) the external library LiquidCrystal_I2C (vendored fixture) compiles to a Xtensa object;
 *  (2) a multi-device sketch — LED, push-button, potentiometer (ADC), PWM (LEDC) and an I2C
 *      character LCD — compiles + links + runs on the XtensaCpu, with every device observed:
 *      the LED follows the button, the pot reading drives the PWM duty, and the LCD shows text.
 *
 * All client-side (backend_compile_count == 0, I8); delay() is virtual-time (I3). The HAL
 * runtime + MMIO peripherals are the same architecture-neutral ones the C3 path uses. Skips
 * when the (gitignored, [CI/HUMAN]) toolchain/SDK is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { LcdI2c } from '@sparklab/components-core';
import { XtensaCpu, SimpleBus, XtensaTrap } from './xtensa.js';
import {
  C3Gpio,
  C3Uart,
  C3Adc,
  C3Ledc,
  C3I2c,
  C3SysTimer,
  C3_GPIO_BASE,
  C3_UART0_BASE,
  C3_ADC_BASE,
  C3_LEDC_BASE,
  C3_I2C0_BASE,
  C3_SYSTIMER_BASE,
} from './esp32c3-soc.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const ESPB = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const WASM_OUT = join(REPO, 'ci', 'toolchain-builder', 'esp32-classic', 'build', 'wasm-out');
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const manifestPath = join(
  here,
  '..',
  '..',
  'toolchain-loader',
  'src',
  '__fixtures__',
  'esp32-classic-complex-sdk-manifest.txt',
);
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const linkerScript = join(here, 'sim-runtime', 'xtensa-flat.ld');
const libDir = join(here, '__fixtures__', 'LiquidCrystal_I2C');
const PKG = join(ESPB, 'arduino-data', 'packages', 'esp32');
const X = join(PKG, 'tools', 'esp-x32', '2601');
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  existsSync(join(X, 'bin')) &&
  existsSync(join(libDir, 'LiquidCrystal_I2C.cpp'));

const CL = join(PKG, 'tools', 'esp32-libs', '3.3.10');
const CORE = join(PKG, 'hardware', 'esp32', '3.3.10');
const CXX = `${X}/xtensa-esp-elf/include/c++/14.2.0`;
const WIRE = `${CORE}/libraries/Wire/src`;
const target = [
  '--target=xtensa-esp-elf',
  '-mcpu=esp32',
  '-Xclang',
  '-target-feature',
  '-Xclang',
  '-windowed',
];
const headerEnv = [
  `--gcc-toolchain=${X}`,
  `--sysroot=${X}/xtensa-esp-elf`,
  '-stdlib=libstdc++',
  '-nobuiltininc',
  '-isystem',
  `${X}/lib/gcc/xtensa-esp-elf/14.2.0/include`,
  '-isystem',
  CXX,
  '-isystem',
  `${CXX}/xtensa-esp-elf/esp32`,
  '-isystem',
  `${CXX}/backward`,
  '-isystem',
  `${X}/xtensa-esp-elf/include`,
];

function cflags(extraIncludes: string[] = []): string[] {
  return [
    ...target,
    ...headerEnv,
    '-Qunused-arguments',
    '-w',
    '-c',
    '-Os',
    '-fno-rtti',
    '-fno-exceptions',
    '-std=gnu++2a',
    '-DF_CPU=240000000L',
    '-DARDUINO=10607',
    '-DARDUINO_ESP32_DEV',
    '-DARDUINO_ARCH_ESP32',
    '-DESP32=ESP32',
    '-DARDUINO_USB_CDC_ON_BOOT=0',
    `@${CL}/flags/defines`,
    '-iprefix',
    `${CL}/include/`,
    `@${CL}/flags/includes`,
    `-I${CL}/qio_qspi/include`,
    `-I${CORE}/cores/esp32`,
    `-I${CORE}/variants/esp32`,
    `-I${WIRE}`,
    ...extraIncludes,
  ];
}
function runtimeArgs(): string[] {
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
function sdkBundle(): ToolInput[] {
  const m = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  return m.map((rel) => ({
    path: join(ESPB, rel),
    bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
  }));
}
function elfLoad(elf: Uint8Array): { entry: number; segs: { addr: number; data: Uint8Array }[] } {
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const phoff = v.getUint32(28, true);
  const phes = v.getUint16(42, true);
  const phn = v.getUint16(44, true);
  const segs: { addr: number; data: Uint8Array }[] = [];
  for (let i = 0; i < phn; i++) {
    const p = phoff + i * phes;
    if (v.getUint32(p, true) !== 1) continue;
    const off = v.getUint32(p + 4, true);
    const vaddr = v.getUint32(p + 8, true);
    const filesz = v.getUint32(p + 16, true);
    if (filesz > 0) segs.push({ addr: vaddr, data: elf.slice(off, off + filesz) });
  }
  return { entry: v.getUint32(24, true), segs };
}

describe.skipIf(!ready)(
  'Stage 5 — ESP32-classic multi-device + external library, client-side (Xtensa)',
  () => {
    it('compiles the external LiquidCrystal_I2C library to a Xtensa object', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const sdk: ToolInput[] = [
        ...sdkBundle(),
        {
          path: '/lib/LiquidCrystal_I2C.h',
          bytes: new Uint8Array(readFileSync(join(libDir, 'LiquidCrystal_I2C.h'))),
        },
      ];
      const r = await tc.compile({
        args: cflags(['-I/lib']),
        sdk,
        sourcePath: '/lib/LiquidCrystal_I2C.cpp',
        sourceBytes: new Uint8Array(readFileSync(join(libDir, 'LiquidCrystal_I2C.cpp'))),
      });
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(r.object[18]! | (r.object[19]! << 8)).toBe(94); // EM_XTENSA — the external lib compiled
    }, 180000);

    it('runs a multi-device sketch (LED + button + pot + PWM + I2C LCD) on the Xtensa emulator', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      // LED on GPIO2 follows the button on GPIO4; the pot (ADC ch 34) drives the PWM duty on pin 15;
      // an I2C character LCD (PCF8574 @ 0x27) shows "Hi" (HD44780 4-bit over Wire).
      const sketch =
        '#include <Arduino.h>\n#include <Wire.h>\n' +
        'static void pcf(unsigned char b){ Wire.beginTransmission(0x27); Wire.write(b); Wire.endTransmission(); }\n' +
        'static void nib(unsigned char d, unsigned char rs){ unsigned char b=(d&0xF0)|rs|0x08; pcf(b|0x04); pcf(b); }\n' +
        'static void ch(char c){ nib(c&0xF0,1); nib(c<<4,1); }\n' +
        "void setup(){ pinMode(2,OUTPUT); pinMode(4,INPUT); ledcAttach(15,5000,8); Wire.begin(); ch('H'); ch('i'); }\n" +
        'void loop(){ int pot=analogRead(34); int btn=digitalRead(4); digitalWrite(2,btn); ledcWrite(15, pot>>4); delay(5); }\n';

      const sk = await tc.compile({
        args: cflags(),
        sdk: sdkBundle(),
        sourcePath: '/sketch/app.cpp',
        sourceBytes: sketch,
      });
      expect(sk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const rt = await tc.compile({
        args: runtimeArgs(),
        sdk: [],
        sourcePath: '/rt.cpp',
        sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
      });
      expect(rt.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const lk = await tc.link({
        args: ['-T', '/xtensa-flat.ld', '--gc-sections', '/sketch.o', '/rt.o'],
        inputs: [
          { path: '/xtensa-flat.ld', bytes: new Uint8Array(readFileSync(linkerScript)) },
          { path: '/sketch.o', bytes: sk.object },
          { path: '/rt.o', bytes: rt.object },
        ],
        outPath: '/fw.elf',
      });
      expect(lk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

      const { entry, segs } = elfLoad(lk.output);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const adc = new C3Adc();
      const ledc = new C3Ledc();
      const i2c = new C3I2c();
      const lcd = new LcdI2c('lcd', 0x27);
      const uart = new C3Uart();
      i2c.attach(0x27, lcd);
      adc.set(34, 2048); // pot at mid-scale
      gpio.setInput(4, 1); // button pressed
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_I2C0_BASE, 0x20, i2c);
      bus.map(C3_LEDC_BASE, 0x100, ledc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_ADC_BASE, 0x100, adc);
      for (const s of segs) bus.ram.set(s.data, s.addr);
      const cpu = new XtensaCpu(bus);
      cpu.pc = entry;
      cpu.setReg(1, 0x30000);

      // run enough loops to exercise every device
      for (let k = 0; k < 5_000_000 && ledc.duty[15] === 0; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof XtensaTrap) break;
          throw e;
        }
      }

      expect(lcd.text).toBe('Hi'); // I2C LCD showed the text (external-lib-style HD44780 protocol)
      expect(gpio.enable & (1 << 2)).toBeTruthy(); // LED configured as output
      expect(gpio.level(2)).toBe(1); // LED follows the (pressed) button
      expect(ledc.duty[15]).toBe(2048 >> 4); // PWM duty driven by the pot reading
    }, 180000);
  },
);
