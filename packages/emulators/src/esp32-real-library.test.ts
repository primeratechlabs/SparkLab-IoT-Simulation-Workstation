/**
 * Proof — the generic library-build path is REAL: a multi-file user library (header + its own .cpp,
 * with real stateful float logic) is compiled as its OWN translation unit and linked with the sketch
 * through the SAME production `buildC3Firmware` the workspace uses. The sketch calls the library's real
 * functions; the firmware runs and prints the library's genuinely-computed output (no shim, no hardcode,
 * no per-library special-casing). This is the answer to "does code actually run according to the library".
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
  existsSync(join(LIBDIR, 'libc.a'));

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

// A realistic third-party-style Arduino library: a header + a SEPARATE .cpp with stateful float math
// (a Welford running mean/variance) + an unmistakable computed result. Nothing here is known to the
// simulator — it must genuinely compile this .cpp and run it for the numbers to come out right.
const LIB_H = `#pragma once
class RunningStats {
public:
  void add(float x);
  float mean() const;
  long variancex100() const; // variance * 100, truncated — a value only the real algorithm produces
private:
  long n_ = 0;
  float mean_ = 0, m2_ = 0;
};
`;
const LIB_CPP = `#include "RunningStats.h"
void RunningStats::add(float x) {
  n_++;
  float d = x - mean_;
  mean_ += d / (float)n_;
  m2_ += d * (x - mean_);
}
float RunningStats::mean() const { return mean_; }
long RunningStats::variancex100() const { return n_ > 1 ? (long)((m2_ / (float)(n_ - 1)) * 100.0f) : 0; }
`;

describe.skipIf(!ready)(
  'Proof — a real multi-file user library compiles + links + RUNS with the sketch',
  () => {
    it('runs the library .cpp genuinely (Welford mean/variance) — no shim, no hardcode', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const enc = new TextEncoder();
      const inc = '/userlib/RunningStats';
      // The sketch uses the library exactly like a real Arduino sketch: #include it, call its methods.
      const sketch =
        '#include <Arduino.h>\n#include <RunningStats.h>\n' +
        'RunningStats s;\n' +
        'void setup(){\n  Serial.begin(115200);\n' +
        '  float data[] = {2.0f, 4.0f, 4.0f, 4.0f, 5.0f, 5.0f, 7.0f, 9.0f};\n' +
        '  for (int i=0;i<8;i++) s.add(data[i]);\n' +
        '  Serial.print("MEAN="); Serial.println((int)(s.mean()*10));\n' + // 5.0 → 50
        '  Serial.print("VAR100="); Serial.println(s.variancex100());\n' + // sample variance 4.5714.. → 457
        '}\nvoid loop(){}\n';

      const built = await buildC3Firmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
        // The library HEADER mounts in the SDK (so #include resolves) and its .cpp SOURCE is passed as a
        // FirmwareLibrary unit — exactly what the build worker does for an uploaded library.
        sdk: [...sdkBundle(), { path: `${inc}/RunningStats.h`, bytes: enc.encode(LIB_H) }],
        root: BUILD,
        libraries: [
          {
            includePath: inc,
            sources: [
              { path: `${inc}/RunningStats.cpp`, bytes: enc.encode(LIB_CPP), language: 'c++' },
            ],
          },
        ],
        archives: stdlibArchives(),
      });
      expect(built.ok).toBe(true); // the library's OWN .cpp compiled + linked (a missing unit would fail here)
      expect(built.elf).toBeDefined();

      const runner = new Rv32Runner(built.elf!);
      for (let i = 0; i < 300 && !/VAR100=-?\d/.test(runner.serial()); i++)
        runner.executeForMillis(20);

      expect(runner.halted).toBe(false);
      expect(runner.serial()).toContain('MEAN=50'); // the library's real mean() ran
      expect(runner.serial()).toContain('VAR100=457'); // the library's real Welford variance ran — unfakeable
    }, 180000);
  },
);
