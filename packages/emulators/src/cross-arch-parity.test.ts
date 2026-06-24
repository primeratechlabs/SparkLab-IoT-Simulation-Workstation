/**
 * C3 ↔ Xtensa PARITY HARNESS (xtensa-core audit, structural safeguard). The same architecture-neutral
 * sketch is compiled + linked to BOTH the ESP32-C3 (rv32, `buildC3Firmware` + `Rv32Runner`) and the
 * ESP32-classic (Xtensa, `buildEsp32ClassicFirmware` + `XtensaRunner`), run for equal virtual time, and
 * the observable behaviour (Serial text + GPIO levels) is asserted IDENTICAL. The Blynk-dead-on-classic
 * bug was a C3-vs-Xtensa divergence that no test cross-checked; this harness catches the whole class.
 *
 * Skips unless BOTH toolchain fixtures (gitignored, [CI/HUMAN]) are present.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { buildC3Firmware, buildEsp32ClassicFirmware } from '@sparklab/build-orchestrator';
import { Rv32Runner } from './rv32-runner.js';
import { XtensaRunner } from './xtensa-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const ESPB = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const C3_WASM = join(ESPB, 'wasm-out');
const XT_WASM = join(REPO, 'ci', 'toolchain-builder', 'esp32-classic', 'build', 'wasm-out');
const fixtures = join(here, '..', '..', 'toolchain-loader', 'src', '__fixtures__');
const c3Manifest = join(fixtures, 'c3-blink-sdk-manifest.txt');
const xtManifest = join(fixtures, 'esp32-classic-sdk-manifest.txt');
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const linkerLd = join(here, 'sim-runtime', 'xtensa-flat.ld');
const PKG = join(ESPB, 'arduino-data', 'packages', 'esp32');
// C3 (rv32imc) has NO hardware FPU, so float math needs libgcc soft-float + picolibc — production passes
// these archives (Xtensa uses its FPU, no archives). The parity test must match that asymmetry.
const C3_GCC = join(PKG, 'tools', 'esp-rv32', '2601');
const C3_ML = 'rv32imc_zicsr_zifencei/ilp32';
const C3_ARCHIVES: [string, string][] = [
  ['/libc.a', join(C3_GCC, 'picolibc', 'riscv32-esp-elf', 'lib', C3_ML, 'libc.a')],
  ['/libm.a', join(C3_GCC, 'picolibc', 'riscv32-esp-elf', 'lib', C3_ML, 'libm.a')],
  ['/libgcc.a', join(C3_GCC, 'lib', 'gcc', 'riscv32-esp-elf', '14.2.0', C3_ML, 'libgcc.a')],
];
const ready =
  existsSync(join(C3_WASM, 'clang.mjs')) &&
  existsSync(join(XT_WASM, 'clang.mjs')) &&
  existsSync(c3Manifest) &&
  existsSync(xtManifest) &&
  existsSync(join(PKG, 'tools', 'esp-rv32', '2601')) &&
  existsSync(join(PKG, 'tools', 'esp-x32', '2601'));

const sdk = (manifest: string): ToolInput[] =>
  readFileSync(manifest, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((rel) => ({
      path: join(ESPB, rel),
      bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
    }));
const runtime = () => new Uint8Array(readFileSync(runtimeCpp));

async function tc(dir: string): Promise<WasmRiscvToolchain> {
  const clang = (await import(join(dir, 'clang.mjs'))).default;
  const lld = (await import(join(dir, 'lld.mjs'))).default;
  return new WasmRiscvToolchain({ clang, lld });
}

/** Build + run on C3; return Serial + the GPIO2 level after `marker` (or timeout). */
async function onC3(sketch: string, marker: RegExp): Promise<{ serial: string; pin2: 0 | 1 }> {
  const archives = C3_ARCHIVES.filter(([, p]) => existsSync(p)).map(([path, p]) => ({
    path,
    bytes: new Uint8Array(readFileSync(p)),
  }));
  const built = await buildC3Firmware({
    toolchain: await tc(C3_WASM),
    sketchSource: `#include <Arduino.h>\n${sketch}`,
    runtimeSource: runtime(),
    sdk: sdk(c3Manifest),
    root: ESPB,
    archives,
  });
  if (!built.ok) throw new Error('C3 build: ' + JSON.stringify(built.diagnostics));
  const r = new Rv32Runner(built.elf!);
  for (let i = 0; i < 400 && !marker.test(r.serial()) && !r.halted; i++) r.executeForMillis(20);
  expect(r.haltReason, `C3 halted: ${r.haltReason}`).toBeNull();
  return { serial: r.serial(), pin2: r.pins[2] ?? 0 };
}

/** Build + run on Xtensa; same shape. */
async function onXtensa(sketch: string, marker: RegExp): Promise<{ serial: string; pin2: 0 | 1 }> {
  const built = await buildEsp32ClassicFirmware({
    toolchain: await tc(XT_WASM),
    sketchSource: `#include <Arduino.h>\n${sketch}`,
    runtimeSource: runtime(),
    linkerScript: new Uint8Array(readFileSync(linkerLd)),
    sdk: sdk(xtManifest),
    root: ESPB,
  });
  if (!built.ok) throw new Error('Xtensa build: ' + JSON.stringify(built.diagnostics));
  const r = new XtensaRunner(built.elf!);
  for (let i = 0; i < 400 && !marker.test(r.serial()) && !r.halted; i++) r.executeForMillis(20);
  expect(r.haltReason, `Xtensa halted: ${r.haltReason}`).toBeNull();
  return { serial: r.serial(), pin2: r.pins[2] ?? 0 };
}

/** Run a sketch on BOTH and assert identical Serial + GPIO2 (the parity guarantee). */
async function parity(sketch: string, marker: RegExp): Promise<string> {
  const [c3, xt] = await Promise.all([onC3(sketch, marker), onXtensa(sketch, marker)]);
  expect(xt.serial, 'Serial text must match across C3 and Xtensa').toBe(c3.serial);
  expect(xt.pin2, 'GPIO2 level must match across C3 and Xtensa').toBe(c3.pin2);
  return c3.serial;
}

describe.skipIf(!ready)(
  'C3 ↔ Xtensa parity — identical sketch, identical observable behaviour',
  () => {
    it('blink + Serial: same output + GPIO2 on both architectures', async () => {
      const s = await parity(
        'void setup(){ Serial.begin(115200); pinMode(2,OUTPUT); digitalWrite(2,HIGH); Serial.println("ready"); } void loop(){}',
        /ready/,
      );
      expect(s).toContain('ready');
    }, 180000);

    it('global constructor (.init_array) runs on BOTH — a non-trivial file-scope ctor initialises its object', async () => {
      // g_seed is volatile so the ctor cannot be constant-folded into static init → it MUST be emitted as a
      // dynamic .init_array entry. If the crt0 runs .init_array, g_flag becomes 123; otherwise it stays 0.
      const sketch =
        'volatile int g_seed = 100; int g_flag = 0;\n' +
        'struct Setter { Setter(){ g_flag = g_seed + 23; } }; Setter g_setter;\n' +
        'void setup(){ Serial.begin(115200); Serial.print("flag="); Serial.println(g_flag); } void loop(){}';
      const s = await parity(sketch, /flag=\d/);
      expect(s).toContain('flag=123'); // ctor ran on BOTH arches (was 'flag=0' before the crt0 fix)
    }, 180000);

    it('single-precision FP arithmetic: same result on both', async () => {
      const s = await parity(
        'void setup(){ Serial.begin(115200); volatile float a=7.5f,b=2.5f; Serial.print("p="); Serial.println((int)(a*b)); } void loop(){}',
        /p=\d/,
      );
      expect(s).toContain('p=18');
    }, 180000);
  },
);
