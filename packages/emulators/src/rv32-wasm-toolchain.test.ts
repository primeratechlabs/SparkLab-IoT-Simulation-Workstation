/**
 * STAGE 4 CAPSTONE — the complete client-side RISC-V vertical, end to end:
 *   wasm clang (compile C → rv32imc object) → wasm lld (link → ELF) → parse PT_LOAD →
 *   load into our Rv32Cpu interpreter → run → check the computed result.
 *
 * Both clang.mjs and lld.mjs are the browser-targetable LLVM we built from scratch
 * (RISCV target, SINGLE_FILE ES6 modules). Node here stands in for the browser Worker —
 * it imports + instantiates the SAME wasm modules the app ships. Proves invariant I8
 * (client-side build, backend≈0) for the ESP32-C3 RISC-V target. Skips when the (gitignored,
 * [CI/HUMAN]) wasm toolchain artifacts are absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Rv32Cpu, SimpleBus, Rv32Trap } from './rv32.js';
import { C3Gpio, C3_GPIO_BASE } from './esp32c3-soc.js';

const here = dirname(fileURLToPath(import.meta.url));
const WASM_OUT = join(
  here,
  '..',
  '..',
  '..',
  'ci',
  'toolchain-builder',
  'esp32',
  'build',
  'wasm-out',
);
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const ready = existsSync(clangMjs) && existsSync(lldMjs);

const C_SRC =
  'void _start(void){volatile int* in=(int*)0x2000;volatile int* out=(int*)0x1000;' +
  'int n=*in,s=0;for(int i=1;i<=n;i++)s+=i;*out=s;__builtin_trap();}\n';

describe.skipIf(!ready)('Stage 4 vertical: wasm clang + lld → rv32 interpreter', () => {
  it('compiles + links a RISC-V program in-process and runs it on our CPU (sum 1..n)', async () => {
    const createClang = (await import(clangMjs)).default;
    const createLld = (await import(lldMjs)).default;

    // 1) wasm clang: C → rv32imc object
    const clang = await createClang({ noInitialRun: true });
    clang.FS.mkdir('/w');
    clang.FS.writeFile('/w/t.c', C_SRC);
    expect(
      clang.callMain([
        '-c',
        '--target=riscv32-esp-elf',
        '-march=rv32imc',
        '-mabi=ilp32',
        '-nostdlib',
        '-ffreestanding',
        '-Os',
        '/w/t.c',
        '-o',
        '/w/t.o',
      ]),
    ).toBe(0);
    const obj = clang.FS.readFile('/w/t.o') as Uint8Array;
    expect(obj[18]! | (obj[19]! << 8)).toBe(243); // EM_RISCV

    // 2) wasm lld: object → flat binary at base 0 (--oformat binary == objcopy -O binary)
    const lld = await createLld({ noInitialRun: true });
    lld.FS.mkdir('/w');
    lld.FS.writeFile('/w/t.o', obj);
    expect(
      lld.callMain([
        '-flavor',
        'gnu',
        '-Ttext=0',
        '-e',
        '_start',
        '--oformat',
        'binary',
        '/w/t.o',
        '-o',
        '/w/t.bin',
      ]),
    ).toBe(0);
    const text = lld.FS.readFile('/w/t.bin') as Uint8Array;
    expect(text.length).toBeGreaterThan(0);

    // 3) load the flat .text at 0x0 and run on our interpreter
    const runSum = (n: number): number => {
      const bus = new SimpleBus(new Uint8Array(0x4000));
      bus.ram.set(text, 0); // _start sits at 0x0
      bus.write32(0x2000, n);
      const cpu = new Rv32Cpu(bus); // pc defaults to 0
      for (let k = 0; k < 100000; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof Rv32Trap) break; // trailing __builtin_trap()
          throw e;
        }
      }
      return bus.read32(0x1000) | 0;
    };

    // the wasm-toolchain-compiled program, run on our CPU, computes the right answers
    expect(runSum(10)).toBe(55);
    expect(runSum(100)).toBe(5050);
    expect(runSum(1)).toBe(1);
  }, 120000);

  it('runs a client-compiled bare-metal C3 GPIO blink and observes the LED toggle (MMIO)', async () => {
    const createClang = (await import(clangMjs)).default;
    const createLld = (await import(lldMjs)).default;

    // bare-metal blink: toggle GPIO8 (C3 builtin LED) 5× via the W1TS/W1TC registers
    const BLINK =
      '#define W1TS (*(volatile unsigned*)0x60004008)\n' +
      '#define W1TC (*(volatile unsigned*)0x6000400c)\n' +
      '#define LED (1u<<8)\n' +
      'void _start(void){for(int i=0;i<5;i++){W1TS=LED;for(volatile int d=0;d<20;d++);W1TC=LED;for(volatile int d=0;d<20;d++);}__builtin_trap();}\n';

    const clang = await createClang({ noInitialRun: true });
    clang.FS.mkdir('/b');
    clang.FS.writeFile('/b/b.c', BLINK);
    expect(
      clang.callMain([
        '-c',
        '--target=riscv32-esp-elf',
        '-march=rv32imc',
        '-mabi=ilp32',
        '-nostdlib',
        '-ffreestanding',
        '-Os',
        '/b/b.c',
        '-o',
        '/b/b.o',
      ]),
    ).toBe(0);
    const obj = clang.FS.readFile('/b/b.o') as Uint8Array;

    const lld = await createLld({ noInitialRun: true });
    lld.FS.mkdir('/b');
    lld.FS.writeFile('/b/b.o', obj);
    expect(
      lld.callMain([
        '-flavor',
        'gnu',
        '-Ttext=0',
        '-e',
        '_start',
        '--oformat',
        'binary',
        '/b/b.o',
        '-o',
        '/b/b.bin',
      ]),
    ).toBe(0);
    const text = lld.FS.readFile('/b/b.bin') as Uint8Array;

    // wire the SoC GPIO block onto the CPU's MMIO space + record LED transitions
    const bus = new SimpleBus(new Uint8Array(0x4000));
    const gpio = new C3Gpio();
    const trace: Array<0 | 1> = [];
    gpio.onChange = (pin, level) => {
      if (pin === 8) trace.push(level);
    };
    bus.map(C3_GPIO_BASE, 0x800, gpio);
    bus.ram.set(text, 0);
    const cpu = new Rv32Cpu(bus);
    cpu.setReg(2, 0x3000); // stack pointer (program does addi sp,sp,-16)
    for (let k = 0; k < 1_000_000; k++) {
      try {
        cpu.step();
      } catch (e) {
        if (e instanceof Rv32Trap) break;
        throw e;
      }
    }

    // 5 on/off cycles → 10 edges on GPIO8, ending LOW; the MMIO model saw every toggle
    expect(gpio.edges[8]).toBe(10);
    expect(trace).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(gpio.level(8)).toBe(0);
  }, 120000);
});
