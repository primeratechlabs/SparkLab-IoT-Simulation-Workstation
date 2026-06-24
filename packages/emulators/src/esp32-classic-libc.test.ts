/**
 * ESP32-classic (Xtensa) REAL libc/libm linking + execution. The classic build is WINDOWED-ABI now, so
 * the windowed-only picolibc esp32 multilib (libc.a/libm.a + libgcc.a) links cleanly with the sketch +
 * HAL shim and RUNS on the windowed XtensaCpu — so a sketch using snprintf + <math> resolves against the
 * real picolibc, exactly like the C3 (rv32) path. Skips when the (gitignored) toolchain/archives are absent.
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
// picolibc + libgcc esp32 multilib (windowed ABI — matches the now-windowed sketch/runtime).
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

describe.skipIf(!ready)('ESP32-classic (Xtensa) — real picolibc libc/libm (windowed ABI)', () => {
  it('a sketch using snprintf + sqrtf links against picolibc and runs correctly', async () => {
    const clang = (await import(clangMjs)).default;
    const lld = (await import(lldMjs)).default;
    const tc = new WasmRiscvToolchain({ clang, lld });
    // Real picolibc end-to-end: heap (malloc/strcpy) + strlen + the VARIADIC vfprintf family (snprintf with
    // %d/%s). This one sketch exercises every Xtensa-core fix together: the windowed register ABI, the LOOP
    // zero-overhead loop (strlen scan + printf digit loop), NSAU (libgcc 64-bit divide in integer→string),
    // and the R_XTENSA_32 jump-table relocation fold (the printf conversion-dispatch switch). A regression in
    // any of them turns "v=42 hi len=2" into garbage or an empty conversion.
    const sketch =
      '#include <Arduino.h>\n#include <string.h>\n#include <stdlib.h>\n' +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  char* heap = (char*)malloc(16); strcpy(heap, "hi");\n' +
      '  char b[64];\n' +
      '  snprintf(b, sizeof(b), "v=%d %s len=%d", 42, heap, (int)strlen(heap));\n' +
      '  free(heap);\n' +
      '  Serial.println(b);\n' +
      '  Serial.println("end");\n' +
      '}\n' +
      'void loop(){}\n';
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
        'LIBC LINK DIAG:\n' +
          built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n'),
      );
    expect(built.ok).toBe(true); // links against the real windowed picolibc

    const runner = new XtensaRunner(built.elf!);
    for (let i = 0; i < 600 && !/end/.test(runner.serial()) && !runner.halted; i++)
      runner.executeForMillis(20);
    expect(runner.haltReason, `halted: ${runner.haltReason}`).toBeNull();
    const s = runner.serial();
    expect(s).toContain('v=42 hi len=2'); // snprintf(%d/%s) via real picolibc — jump-table dispatch fixed by reloc normalization
  }, 180000);
});
