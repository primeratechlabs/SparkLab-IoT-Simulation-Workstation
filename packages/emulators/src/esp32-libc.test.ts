/**
 * Gate — a client-built ESP32-C3 sketch that uses the C/C++ STANDARD LIBRARY (memcpy via a struct copy,
 * `new`/`delete` → malloc/free, integer math) genuinely compiles, LINKS the real picolibc + libgcc
 * archives, and RUNS correctly on the emulator. This is the fix for "most real libraries fail to link":
 * the firmware now links libc/libm/libgcc (members pulled on demand) + the runtime shim's malloc heap.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { buildC3Firmware } from '@sparklab/build-orchestrator';
import { Rv32Runner } from './rv32-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const BUILD = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const WASM_OUT = join(BUILD, 'wasm-out');
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const fixtures = join(here, '..', '..', 'toolchain-loader', 'src', '__fixtures__');
const manifestPath = join(fixtures, 'c3-blink-sdk-manifest.txt');
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const PKG = join(BUILD, 'arduino-data', 'packages', 'esp32');
const GCC = join(PKG, 'tools', 'esp-rv32', '2601');
const LIBDIR = join(GCC, 'picolibc', 'riscv32-esp-elf', 'lib', 'rv32imc_zicsr_zifencei', 'ilp32');
const LIBGCC = join(
  GCC,
  'lib',
  'gcc',
  'riscv32-esp-elf',
  '14.2.0',
  'rv32imc_zicsr_zifencei',
  'ilp32',
  'libgcc.a',
);
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  existsSync(join(LIBDIR, 'libc.a')) &&
  existsSync(LIBGCC);

function sdkBundle(): ToolInput[] {
  const entries = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  return entries.map((rel) => ({
    path: join(BUILD, rel),
    bytes: new Uint8Array(readFileSync(join(BUILD, rel))),
  }));
}
function stdlibArchives(): { path: string; bytes: Uint8Array }[] {
  return [
    { path: '/libc.a', bytes: new Uint8Array(readFileSync(join(LIBDIR, 'libc.a'))) },
    { path: '/libm.a', bytes: new Uint8Array(readFileSync(join(LIBDIR, 'libm.a'))) },
    { path: '/libgcc.a', bytes: new Uint8Array(readFileSync(LIBGCC)) },
  ];
}

describe.skipIf(!ready)(
  'Gate — ESP32-C3 sketch linking the real standard library (memcpy/new/malloc)',
  () => {
    it('compiles + links libc/libgcc + runs: struct copy (memcpy) and new[]/delete[] (malloc) work for real', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      // memcpy (a sizeable struct copy), new[]/delete[] (heap), and a real computation whose result we print.
      const sketch =
        '#include <Arduino.h>\n' +
        'struct Reading { char tag[64]; int v[8]; };\n' +
        'static volatile int seed = 1;\n' +
        'void setup(){\n' +
        '  Serial.begin(115200);\n' +
        '  Reading a; for (int i=0;i<64;i++) a.tag[i]=(char)i; for (int i=0;i<8;i++) a.v[i]=seed+i;\n' +
        '  Reading b = a;                 // struct copy -> memcpy\n' +
        '  int* p = new int[8];           // operator new[] -> malloc -> sbrk\n' +
        '  int sum=0; for (int i=0;i<8;i++){ p[i]=b.v[i]*b.v[i]; sum+=p[i]; }\n' +
        '  delete[] p;                    // operator delete[] -> free\n' +
        '  Serial.print("SUM="); Serial.println(sum);\n' +
        '}\n' +
        'void loop(){}\n';

      const built = await buildC3Firmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
        sdk: sdkBundle(),
        root: BUILD,
        archives: stdlibArchives(),
      });
      expect(built.ok).toBe(true);
      expect(built.elf).toBeDefined();

      const runner = new Rv32Runner(built.elf!);
      for (let i = 0; i < 200 && !runner.serial().includes('SUM='); i++)
        runner.executeForMillis(20);

      expect(runner.halted).toBe(false); // no trap — malloc/memcpy/free executed cleanly
      expect(runner.serial()).toContain('SUM=204'); // 1²+2²+…+8² = 204, computed via heap-allocated array
    }, 180000);
  },
);
