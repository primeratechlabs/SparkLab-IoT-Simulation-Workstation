/**
 * STAGE 5 — the full ESP32-classic (Xtensa) vertical, client-side (sim build profile, §22):
 *   real Arduino sketch  --wasm esp-clang (Xtensa)-->  object
 *   sim runtime (HAL+crt0) --wasm esp-clang------------>  object
 *   both                 --wasm lld (Xtensa)--------->  firmware ELF
 *   firmware             --XtensaCpu---------------->  runs, GPIO MMIO observed
 *
 * Mirrors the C3 sim profile but on the Xtensa interpreter — the SAME architecture-neutral
 * Arduino HAL runtime + MMIO peripherals are reused. The sketch is compiled UNCHANGED against
 * the real arduino-esp32 (classic) headers, with the windowed-register option OFF (call0), and
 * linked against the HAL shim instead of the full IDF. backend_compile_count stays 0 (I8);
 * delay() is virtual-time (I3). Skips when the (gitignored, [CI/HUMAN]) toolchain/SDK is absent.
 *
 * WasmRiscvToolchain is reused purely as a generic wasm clang/lld driver (mount files + run
 * argv) — the architecture lives entirely in the flags passed here.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { XtensaCpu, SimpleBus, XtensaTrap } from './xtensa.js';
import {
  C3Gpio,
  C3Uart,
  C3SysTimer,
  C3_GPIO_BASE,
  C3_UART0_BASE,
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
  'esp32-classic-sdk-manifest.txt',
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

function sketchArgs(): string[] {
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

/** Parse PT_LOAD segments + entry from a little-endian ELF32. */
function elfLoad(elf: Uint8Array): { entry: number; segs: { addr: number; data: Uint8Array }[] } {
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const entry = v.getUint32(24, true);
  const phoff = v.getUint32(28, true);
  const phes = v.getUint16(42, true);
  const phn = v.getUint16(44, true);
  const segs: { addr: number; data: Uint8Array }[] = [];
  for (let i = 0; i < phn; i++) {
    const p = phoff + i * phes;
    if (v.getUint32(p, true) !== 1) continue; // PT_LOAD
    const off = v.getUint32(p + 4, true);
    const vaddr = v.getUint32(p + 8, true);
    const filesz = v.getUint32(p + 16, true);
    if (filesz > 0) segs.push({ addr: vaddr, data: elf.slice(off, off + filesz) });
  }
  return { entry, segs };
}

describe.skipIf(!ready)(
  'Stage 5 — client-built ESP32-classic sketch runs on the Xtensa emulator (sim profile)',
  () => {
    it('compiles the real Arduino blink+Serial (Xtensa), links the HAL shim, observes GPIO2 + Serial (I8 + I3)', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      const sketch =
        '#include <Arduino.h>\nvoid setup(){ pinMode(2, OUTPUT); Serial.begin(115200); }\n' +
        'void loop(){ digitalWrite(2, HIGH); Serial.println("on"); delay(5); digitalWrite(2, LOW); delay(5); }\n';
      const sk = await tc.compile({
        args: sketchArgs(),
        sdk: sdkBundle(),
        sourcePath: '/sketch/blink.cpp',
        sourceBytes: sketch,
      });
      expect(sk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(sk.exitCode).toBe(0);
      expect(sk.object[18]! | (sk.object[19]! << 8)).toBe(94); // EM_XTENSA

      const rt = await tc.compile({
        args: runtimeArgs(),
        sdk: [],
        sourcePath: '/rt.cpp',
        sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
      });
      expect(rt.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

      // link with the .literal-before-.text script so Xtensa L32R resolves
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
      expect([lk.output[0], lk.output[1], lk.output[2], lk.output[3]]).toEqual([
        0x7f, 0x45, 0x4c, 0x46,
      ]);

      // run on the Xtensa interpreter with the (reused) C3 GPIO peripheral
      const { entry, segs } = elfLoad(lk.output);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const trace: Array<0 | 1> = [];
      gpio.onChange = (pin, level) => {
        if (pin === 2) trace.push(level);
      };
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      for (const s of segs) bus.ram.set(s.data, s.addr);
      const cpu = new XtensaCpu(bus);
      const timer = new C3SysTimer(() => cpu.cycles, 50); // virtual-time millis → delay() terminates (I3)
      bus.map(C3_SYSTIMER_BASE, 0x10, timer);
      cpu.pc = entry;
      cpu.setReg(1, 0x30000); // a1 = stack pointer
      for (let k = 0; k < 5_000_000 && trace.length < 6; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof XtensaTrap) break;
          throw e;
        }
      }

      expect(gpio.enable & (1 << 2)).toBeTruthy(); // setup() enabled GPIO2 output
      expect(trace.length).toBeGreaterThanOrEqual(4);
      expect(trace.slice(0, 4)).toEqual([1, 0, 1, 0]); // HIGH, LOW, HIGH, LOW …
      expect(uart.text()).toContain('on\r\n'); // Serial.println("on") each loop
      expect(uart.text().match(/on/g)!.length).toBeGreaterThanOrEqual(2);
    }, 180000);
  },
);
