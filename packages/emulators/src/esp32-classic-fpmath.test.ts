/**
 * ESP32-classic (Xtensa) REAL float divide + sqrtf via the LX6 FP-division/square-root OPTION. The LX6 FPU
 * has NO scalar DIV.S/SQRT.S; `a/b` and `sqrtf(x)` resolve to libgcc macro-sequences (__divsf3 /
 * __ieee754_sqrtf) built from the seed/iteration ops (DIV0/SQRT0/NEXP01/MADDN/DIVN/ADDEXP) + MKDADJ/MKSADJ.
 * The interpreter models that option exactly as QEMU does (seeds+iteration are no-ops; MKSADJ/MKDADJ compute
 * the true sqrt/divide; ADDEXPM moves it out) — so the fixed gcc schedule yields the correctly-rounded IEEE
 * result. Wrong opcode/operand decode would FAIL here (values are checked). Skips when the toolchain/archives
 * are absent. Mirrors esp32-classic-libc.test.ts for the archive set.
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
  'esp32-classic-wifi-sdk-manifest.txt',
);
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const linkerLd = join(here, 'sim-runtime', 'xtensa-flat.ld');
const X = join(ESPB, 'arduino-data', 'packages', 'esp32', 'tools', 'esp-x32', '2601');
const ARCHIVES: [string, string][] = [
  ['/libc.a', join(X, 'picolibc', 'xtensa-esp-elf', 'lib', 'esp32', 'libc.a')],
  ['/libm.a', join(X, 'picolibc', 'xtensa-esp-elf', 'lib', 'esp32', 'libm.a')],
  ['/libgcc.a', join(X, 'picolibc', 'lib', 'gcc', 'xtensa-esp-elf', '14.2.0', 'esp32', 'libgcc.a')],
];
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  ARCHIVES.every(([, p]) => existsSync(p));

const sdkBundle = (): ToolInput[] =>
  readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((rel) => ({
      path: join(ESPB, rel),
      bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
    }));

describe.skipIf(!ready)(
  'ESP32-classic (Xtensa) — real float divide + sqrtf (FP-division/sqrt option)',
  () => {
    it('sqrtf and `/` compute correct IEEE results through __ieee754_sqrtf / __divsf3', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // `volatile` defeats constant-folding so the real libgcc sequences run. Printed as int×100 (2 decimals)
      // via the shim's own number printing (no printf), so this isolates the FP option from vfprintf.
      const sketch =
        '#include <Arduino.h>\n#include <math.h>\n' +
        'static volatile float two = 2.0f, sixteen = 16.0f, quarter = 0.25f, seven = 7.0f, twof = 2.0f;\n' +
        'void setup(){\n' +
        '  Serial.begin(115200);\n' +
        '  Serial.print("S2="); Serial.println((int)(sqrtf(two) * 100.0f));\n' + // 141 (1.41421)
        '  Serial.print("S16="); Serial.println((int)(sqrtf(sixteen) * 100.0f));\n' + // 400 (4.0)
        '  Serial.print("S025="); Serial.println((int)(sqrtf(quarter) * 100.0f));\n' + // 50  (0.5)
        '  Serial.print("DIV="); Serial.println((int)((seven / twof) * 100.0f));\n' + // 350 (3.5)
        '  Serial.println("end");\n' +
        '}\nvoid loop(){}\n';
      const built = await buildEsp32ClassicFirmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
        linkerScript: new Uint8Array(readFileSync(linkerLd)),
        sdk: sdkBundle(),
        root: ESPB,
        archives: ARCHIVES.map(([path, p]) => ({ path, bytes: new Uint8Array(readFileSync(p)) })),
      });
      if (!built.ok)
        console.log(
          'FPMATH LINK DIAG:\n' +
            built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n'),
        );
      expect(built.ok).toBe(true);

      const runner = new XtensaRunner(built.elf!);
      for (let i = 0; i < 600 && !/end/.test(runner.serial()) && !runner.halted; i++)
        runner.executeForMillis(20);
      expect(runner.haltReason, `halted: ${runner.haltReason}`).toBeNull(); // no unimplemented FP seed op
      const s = runner.serial();
      expect(s).toContain('S2=141'); // sqrtf(2) = 1.41421
      expect(s).toContain('S16=400'); // sqrtf(16) = 4.0 (even exponent)
      expect(s).toContain('S025=50'); // sqrtf(0.25) = 0.5 (negative exponent)
      expect(s).toContain('DIV=350'); // 7.0 / 2.0 = 3.5 (real __divsf3)
    }, 180000);

    it('common transcendental math (sinf/cosf/expf/logf/powf/fmodf/ldexpf) runs to correct results', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // picolibc's libm transcendentals are pure software built on the same FP add/mul/madd/divide/sqrt + the
      // integer shifts that pick apart the IEEE fields — if any opcode were missing/wrong they fail here.
      // (powf/fmodf were the regression that uncovered the SRAI source/shift-field swap, fixed in xtensa.ts.)
      const sketch =
        '#include <Arduino.h>\n#include <math.h>\n' +
        'static volatile float half = 0.5f, one = 1.0f, hundred = 100.0f, eight = 8.0f, three = 3.0f, seven5 = 7.5f;\n' +
        'void setup(){\n' +
        '  Serial.begin(115200);\n' +
        '  Serial.print("SIN="); Serial.println((int)(sinf(half) * 1000.0f));\n' + // 479 (0.4794)
        '  Serial.print("COS="); Serial.println((int)(cosf(one) * 1000.0f));\n' + // 540 (0.5403)
        '  Serial.print("EXP="); Serial.println((int)(expf(one) * 1000.0f));\n' + // 2718 (e=2.71828)
        '  Serial.print("LOG="); Serial.println((int)(logf(hundred) * 1000.0f));\n' + // 4605 (ln100=4.60517)
        '  Serial.print("POW="); Serial.println((int)(powf(eight, three)));\n' + // 512 (8^3)
        '  Serial.print("MOD="); Serial.println((int)(fmodf(seven5, three) * 100.0f));\n' + // 150 (7.5%3=1.5)
        '  Serial.print("LDX="); Serial.println((int)ldexpf(three, 4));\n' + // 48 (3*2^4, scalbnf)
        '  Serial.println("end");\n' +
        '}\nvoid loop(){}\n';
      const built = await buildEsp32ClassicFirmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
        linkerScript: new Uint8Array(readFileSync(linkerLd)),
        sdk: sdkBundle(),
        root: ESPB,
        archives: ARCHIVES.map(([path, p]) => ({ path, bytes: new Uint8Array(readFileSync(p)) })),
      });
      if (!built.ok)
        console.log(
          'MATH LINK DIAG:\n' +
            built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n'),
        );
      expect(built.ok).toBe(true);

      const runner = new XtensaRunner(built.elf!);
      for (let i = 0; i < 800 && !/end/.test(runner.serial()) && !runner.halted; i++)
        runner.executeForMillis(20);
      expect(runner.haltReason, `halted: ${runner.haltReason}`).toBeNull(); // no unimplemented opcode in libm
      const s = runner.serial();
      expect(s).toContain('SIN=479'); // sinf(0.5)
      expect(s).toContain('COS=540'); // cosf(1.0)
      expect(s).toContain('EXP=2718'); // expf(1.0) = e
      expect(s).toContain('LOG=4605'); // logf(100)
      expect(s).toContain('POW=512'); // powf(8,3)
      expect(s).toContain('MOD=150'); // fmodf(7.5, 3) = 1.5
      expect(s).toContain('LDX=48'); // ldexpf/scalbnf (exponent reconstruct)
    }, 180000);
  },
);
