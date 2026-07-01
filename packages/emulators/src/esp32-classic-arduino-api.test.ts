/**
 * ESP32-classic (Xtensa) — standard Arduino API symbols the HAL shim used to be MISSING (a real sketch
 * linked against arduino-esp32's Arduino.h/Print.h but failed to LINK): `map`, `Serial.printf`, `pulseIn`.
 * This compiles + runs a sketch that uses all three and checks the results, so a normal sketch (e.g. an
 * HC-SR04 reader using pulseIn + Serial.printf) works without hand-rolled work-arounds. Skips when the
 * gitignored toolchain/archives are absent. Shares the harness with esp32-classic-fpmath.test.ts.
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
  'ESP32-classic (Xtensa) — standard Arduino API (map / Serial.printf / pulseIn)',
  () => {
    it('links + runs map, Serial.printf and pulseIn from a normal sketch', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const sketch = `#include <Arduino.h>
void setup(){
  Serial.begin(115200);
  long m = map(512, 0, 1023, 0, 180);              // 512/1023 of 180 = 90
  Serial.print("MAP="); Serial.println(m);
  Serial.printf("PF=%d,%ld,%s\\n", 42, 100000L, "ok");   // integer + long + string formatting
  unsigned long p = pulseIn(4, HIGH, 500);         // no stimulus → returns 0 on timeout (links + no trap)
  Serial.print("PULSE="); Serial.println((long)p);
  Serial.println("end");
}
void loop(){}
`;
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
          'API LINK DIAG:\n' +
            built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n'),
        );
      expect(built.ok, 'sketch using map/printf/pulseIn must LINK').toBe(true);

      const runner = new XtensaRunner(built.elf!);
      for (let i = 0; i < 800 && !/end/.test(runner.serial()) && !runner.halted; i++)
        runner.executeForMillis(20);
      expect(runner.haltReason, `halted: ${runner.haltReason}`).toBeNull();
      const s = runner.serial();
      console.log('API SERIAL:', s.replace(/\r?\n/g, ' | ').trim());
      expect(s).toContain('MAP=90'); // map() computed correctly
      expect(s).toContain('PF=42,100000,ok'); // Serial.printf %d/%ld/%s
      expect(s).toContain('PULSE=0'); // pulseIn linked + returned on timeout without trapping
      expect(s).toContain('end'); // execution continued past all three
    }, 180000);
  },
);
