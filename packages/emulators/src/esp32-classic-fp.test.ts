/**
 * Gate — ESP32-classic (Xtensa) single-precision FPU. A sketch doing real float arithmetic, comparison,
 * and int<->float conversion compiles and RUNS to the correct results on the Xtensa interpreter (FP
 * register file + LSI/SSI + FP0 arith/convert + FP1 compare + BT/BF). The expected values are checked,
 * so a wrong opcode decode would FAIL here (not silently produce garbage). Float divide + sqrtf are NOT in
 * this (archive-free) test — they resolve to libgcc's FP-division/sqrt-option sequences; see
 * esp32-classic-fpmath.test.ts, which links the real libgcc and checks `/` and sqrtf() compute correctly.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { buildEsp32ClassicFirmware } from '@sparklab/build-orchestrator';
import { XtensaRunner } from './xtensa-runner.js';

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
const linkerLd = join(here, 'sim-runtime', 'xtensa-flat.ld');
const ready = existsSync(clangMjs) && existsSync(lldMjs) && existsSync(manifestPath);

function sdkBundle(): ToolInput[] {
  const rels = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  return rels.map((rel) => ({
    path: join(ESPB, rel),
    bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
  }));
}

describe.skipIf(!ready)('Gate — ESP32-classic (Xtensa) single-precision FPU', () => {
  it('float +,-,*, MADD, NEG, ABS, compare+branch, int<->float all compute correctly', async () => {
    const clang = (await import(clangMjs)).default;
    const lld = (await import(lldMjs)).default;
    const tc = new WasmRiscvToolchain({ clang, lld });
    const sketch =
      '#include <Arduino.h>\n#include <math.h>\n' +
      'static volatile float a = 7.5f, b = 2.5f, c = -3.0f;\n' +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  float sum = a + b;            // 10.0  ADD.S\n' +
      '  float diff = a - b;           // 5.0   SUB.S\n' +
      '  float prod = a * b;           // 18.75 MUL.S\n' +
      '  float fma = a * b + c;        // 15.75 MADD.S (or mul+add)\n' +
      '  float neg = -a;               // -7.5  NEG.S\n' +
      '  float ab = fabsf(c);          // 3.0   ABS.S\n' +
      '  int si = (int)prod;           // 18    TRUNC.S\n' +
      '  float fi = (float)(si + 2);   // 20.0  FLOAT.S\n' +
      '  int gt = (a > b) ? 1 : 0;     // 1     OLT.S + BT/BF\n' +
      '  int le = (a <= b) ? 1 : 0;    // 0     OLE.S + BT/BF\n' +
      '  static volatile unsigned uu = 41u;\n' +
      '  static volatile float vf = 7.7f;\n' +
      '  float ufl = (float)uu;        // 41.0  UFLOAT.S (unsigned→float)\n' +
      '  unsigned utr = (unsigned)vf;  // 7     UTRUNC.S (float→unsigned)\n' +
      '  Serial.print("S="); Serial.println((int)sum);\n' +
      '  Serial.print("D="); Serial.println((int)diff);\n' +
      '  Serial.print("P="); Serial.println(si);\n' +
      '  Serial.print("M="); Serial.println((int)fma);\n' +
      '  Serial.print("N="); Serial.println((int)neg);\n' +
      '  Serial.print("A="); Serial.println((int)ab);\n' +
      '  Serial.print("F="); Serial.println((int)fi);\n' +
      '  Serial.print("G="); Serial.println(gt);\n' +
      '  Serial.print("L="); Serial.println(le);\n' +
      '  Serial.print("U="); Serial.println((int)ufl);\n' +
      '  Serial.print("T="); Serial.println((int)utr);\n' +
      '}\n' +
      'void loop(){}\n';
    const built = await buildEsp32ClassicFirmware({
      toolchain: tc,
      sketchSource: sketch,
      runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
      linkerScript: new Uint8Array(readFileSync(linkerLd)),
      sdk: sdkBundle(),
      root: ESPB,
    });
    if (!built.ok)
      console.log(
        'FP BUILD DIAG:\n' +
          built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n'),
      );
    expect(built.ok).toBe(true);

    const runner = new XtensaRunner(built.elf!);
    // Loop until the LAST line (T=) is printed — not L=, which is mid-output (windowed firmware is a few
    // cycles slower per call, so L= can appear before U=/T= finish).
    for (let i = 0; i < 400 && !/T=\d/.test(runner.serial()) && !runner.halted; i++)
      runner.executeForMillis(20);

    expect(runner.haltReason).toBeNull(); // no unimplemented FP opcode
    const s = runner.serial();
    expect(s).toContain('S=10'); // a+b
    expect(s).toContain('D=5'); // a-b
    expect(s).toContain('P=18'); // (int)(a*b)
    expect(s).toContain('M=15'); // (int)(a*b+c) = (int)15.75
    expect(s).toContain('N=-7'); // (int)(-a) = (int)(-7.5)
    expect(s).toContain('A=3'); // fabsf(-3)
    expect(s).toContain('F=20'); // (float)(18+2)
    expect(s).toContain('G=1'); // a>b
    expect(s).toContain('L=0'); // !(a<=b)
    expect(s).toContain('U=41'); // UFLOAT.S (unsigned→float)
    expect(s).toContain('T=7'); // UTRUNC.S (float→unsigned)
  }, 180000);
});
