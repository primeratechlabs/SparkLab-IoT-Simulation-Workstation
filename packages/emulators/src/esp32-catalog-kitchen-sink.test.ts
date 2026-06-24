/**
 * Kitchen-sink CATALOG integration — ESP32 (Xtensa classic), client-side. The ESP32
 * analogue of the Uno kitchen-sink: the broadest set of catalog peripherals on one
 * ESP32, driven by a single multi-mode sketch compiled + linked 100% in-browser
 * (clang/lld → Xtensa ELF) and run on the XtensaCpu over the architecture-neutral
 * MMIO SoC. Each catalog part is exercised through the firmware:
 *
 *   LED (GPIO2, 'led')              push-button (GPIO4, 'pushbutton-6mm')
 *   slide-switch (GPIO5, 'slide-switch')   potentiometer (ADC34, 'potentiometer')
 *   slide-potentiometer (ADC35, 'slide-potentiometer')
 *   sound sensor (ADC32, 'small-sound-sensor')
 *   PWM duty out (GPIO15, LEDC)     I2C LCD (0x27, 'lcd2004', HD44780 over Wire)
 *
 * Complex firmware: the slide-switch selects whether the rotary or slide pot drives the
 * PWM duty; the button mirrors onto the LED; a loud mic mutes the PWM. Three input phases
 * prove every device is read + actuated in the same run. Skips when the gitignored
 * ([CI/HUMAN]) Xtensa toolchain/SDK is absent.
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
const PKG = join(ESPB, 'arduino-data', 'packages', 'esp32');
const X = join(PKG, 'tools', 'esp-x32', '2601');
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  existsSync(join(X, 'bin'));

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
  'Catalog kitchen-sink — ESP32 (Xtensa): many catalog parts, one complex sketch',
  () => {
    it('compiles + links a multi-mode sketch client-side and every catalog device reacts', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      // LED(2)=button(4); slide-switch(5) picks pot(ADC34) vs slide-pot(ADC35) for the PWM duty(15);
      // a loud mic(ADC32) mutes the PWM; an I2C LCD (PCF8574 @ 0x27) shows "OK" (HD44780 4-bit).
      const sketch =
        '#include <Arduino.h>\n#include <Wire.h>\n' +
        'static void pcf(unsigned char b){ Wire.beginTransmission(0x27); Wire.write(b); Wire.endTransmission(); }\n' +
        'static void nib(unsigned char d, unsigned char rs){ unsigned char b=(d&0xF0)|rs|0x08; pcf(b|0x04); pcf(b); }\n' +
        'static void ch(char c){ nib(c&0xF0,1); nib(c<<4,1); }\n' +
        "void setup(){ pinMode(2,OUTPUT); pinMode(4,INPUT); pinMode(5,INPUT); ledcAttach(15,5000,8); Wire.begin(); ch('O'); ch('K'); }\n" +
        'void loop(){\n' +
        '  int pot=analogRead(34); int slide=analogRead(35); int mic=analogRead(32);\n' +
        '  int btn=digitalRead(4); int mode=digitalRead(5);\n' +
        '  int src = mode ? slide : pot;\n' +
        '  int duty = (mic > 2000) ? 0 : (src >> 4);\n' +
        '  digitalWrite(2, btn);\n' +
        '  ledcWrite(15, duty);\n' +
        '  delay(5);\n' +
        '}\n';

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
      const lcd = new LcdI2c('lcd', 0x27); // catalog 'lcd2004'
      const uart = new C3Uart();
      i2c.attach(0x27, lcd);
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

      const step = (budget: number, until: () => boolean): boolean => {
        for (let k = 0; k < budget; k++) {
          if (until()) return true;
          try {
            cpu.step();
          } catch (e) {
            if (e instanceof XtensaTrap) return until();
            throw e;
          }
        }
        return until();
      };

      // Phase 1 — slide-switch LOW→mode 0 (rotary pot drives PWM), button pressed, quiet mic.
      adc.set(34, 2048); // potentiometer (ADC34) mid-scale
      adc.set(35, 4000); // slide-potentiometer (ADC35) high
      adc.set(32, 500); // sound sensor (ADC32) quiet
      gpio.setInput(4, 1); // button pressed
      gpio.setInput(5, 0); // slide-switch → mode 0
      expect(step(6_000_000, () => ledc.duty[15] === 2048 >> 4)).toBe(true);

      expect(lcd.text).toBe('OK'); // I2C LCD (lcd2004 model) showed text
      expect(gpio.enable & (1 << 2)).toBeTruthy(); // LED pin configured as output
      expect(gpio.level(2)).toBe(1); // LED follows the pressed button
      expect(ledc.duty[15]).toBe(2048 >> 4); // PWM duty driven by the rotary pot (128)

      // Phase 2 — flip slide-switch HIGH→mode 1 (slide pot now drives PWM), release the button.
      gpio.setInput(5, 1); // mode 1 → slide pot source
      gpio.setInput(4, 0); // button released
      expect(step(6_000_000, () => ledc.duty[15] === 4000 >> 4 && gpio.level(2) === 0)).toBe(true);
      expect(ledc.duty[15]).toBe(4000 >> 4); // PWM duty now follows the slide pot (250)
      expect(gpio.level(2)).toBe(0); // LED off (button released)

      // Phase 3 — loud mic must mute the PWM (proves ADC32 / the sound sensor is actually read).
      adc.set(32, 3000); // sound sensor loud (> 2000)
      expect(step(6_000_000, () => ledc.duty[15] === 0)).toBe(true);
      expect(ledc.duty[15]).toBe(0); // loud mic gated the PWM to 0

      console.log(`\n----- Catalog kitchen-sink (ESP32 Xtensa, client-side build) -----`);
      console.log(`  LCD text        : "${lcd.text}"`);
      console.log(
        `  PWM duty (LEDC) : mode0 pot→128, mode1 slide→250, loud-mic→0  (final ${ledc.duty[15]})`,
      );
      console.log(
        `  LED (GPIO2)     : followed button press→release; slide-switch + sound sensor both read`,
      );
    }, 180_000);
  },
);
