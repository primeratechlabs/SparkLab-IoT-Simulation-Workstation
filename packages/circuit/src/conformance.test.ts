/**
 * Stage 3 conformance — golden-trace differential tests (gate #7). A real sketch is
 * compiled client-side, run through the kernel, and its observable trace is diffed
 * against a reference with the conformance comparator. References here are
 * SIMULATOR-GENERATED and UNCALIBRATED (no hardware rig yet — invariant I7; see
 * docs/fidelity-ledger.md). They guard against regressions, not against real silicon.
 * Skips when the gitignored toolchain is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  WasmAvrToolchain,
  type AvrSdk,
  type SdkFile,
  type EmscriptenModuleFactory,
} from '@sparklab/toolchain-loader';
import { parseIntelHex } from '@sparklab/emulators';
import { compareTraces, type Trace } from '@sparklab/conformance';
import { Circuit } from './circuit.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const LDSCRIPT = join(REPO, 'packages', 'emulators', 'test-fixtures', 'avr5-ld.x');
const ready = existsSync(join(GCC, 'cc1plus')) && existsSync(join(SDK_ROOT, 'lib', 'core.a'));

const enc = new TextEncoder();
const factory = async (p: string): Promise<EmscriptenModuleFactory> =>
  (await import(p)).default as EmscriptenModuleFactory;
function walk(dir: string, base = dir): SdkFile[] {
  const out: SdkFile[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push({ path: relative(base, p), bytes: readFileSync(p) });
  }
  return out;
}

/** Core-only firmware build (no external libraries) — fast for the conformance sketches. */
async function buildCore(sketch: string): Promise<Uint8Array> {
  const libDir = join(SDK_ROOT, 'lib');
  const sdk: AvrSdk = {
    headerMounts: ['core', 'variant', 'avr-libc', 'gcc'].map((d) => ({
      mount: `/sdk/${d}`,
      files: walk(join(SDK_ROOT, 'headers', d)),
    })),
    crt: readFileSync(join(libDir, 'crtatmega328p.o')),
    coreA: readFileSync(join(libDir, 'core.a')),
    libs: ['libgcc.a', 'libm.a', 'libc.a', 'libatmega328p.a'].map((name) => ({
      name,
      bytes: readFileSync(join(libDir, 'avr5', name)),
    })),
    ldscript: readFileSync(LDSCRIPT),
  };
  const tc = new WasmAvrToolchain(
    {
      cc1plus: await factory(join(GCC, 'cc1plus')),
      cc1: await factory(join(GCC, 'cc1')),
      avrAs: await factory(join(BIN, 'avr-as')),
      avrLd: await factory(join(BIN, 'avr-ld')),
    },
    sdk,
  );
  const flags = [
    '-Os',
    '-ffunction-sections',
    '-fdata-sections',
    '-DF_CPU=16000000L',
    '-DARDUINO=10808',
    '-DARDUINO_AVR_UNO',
    '-DARDUINO_ARCH_AVR',
  ];
  const obj = await tc.compile({
    sourceKey: 'sha256:s',
    sourceBytes: enc.encode(sketch),
    target: 'avr',
    flags,
    includedHeaderHashes: [],
  });
  expect(obj.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  const linked = await tc.link({ objects: [obj.object], target: 'avr', flags: [] });
  expect(linked.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  const oc = await (
    await factory(join(BIN, 'avr-objcopy'))
  )({ noInitialRun: true, print: () => {}, printErr: () => {} });
  oc.FS.writeFile('/b.elf', linked.elf);
  try {
    oc.callMain(['-O', 'ihex', '/b.elf', '/b.hex']);
  } catch (e) {
    if (!(e && typeof e === 'object' && 'status' in e)) throw e;
  }
  return parseIntelHex(new TextDecoder().decode(oc.FS.readFile('/b.hex'))).bytes;
}

describe.skipIf(!ready)('Stage 3 conformance — golden traces (uncalibrated, I7)', () => {
  it('blink_timing: D13 toggles at 1 Hz matches the reference within tolerance', async () => {
    const fw = await buildCore(`#include <Arduino.h>
void setup(){ pinMode(13, OUTPUT); }
void loop(){ digitalWrite(13, HIGH); delay(1000); digitalWrite(13, LOW); delay(1000); }`);
    const circuit = new Circuit(fw);
    const recorded: Trace = [];
    let last: 0 | 1 | null = null;
    circuit.runner.addGpioListener('B', () => {
      const v = (circuit.runner.pinState('B', 5) === 1 ? 1 : 0) as 0 | 1; // D13 = PB5
      if (v !== last) {
        last = v;
        recorded.push({ tNs: circuit.runner.virtualTimeNs, kind: 'gpio', key: `13=${v}` });
      }
    });
    circuit.run(
      4200,
      () => recorded.filter((e) => e.key === '13=1').length >= 2 && recorded.length >= 5,
    );

    // Align to the first real HIGH (after the pinMode-output-low settle) and rebase time.
    const firstHigh = recorded.find((e) => e.key === '13=1')!;
    const aligned: Trace = recorded
      .filter((e) => e.tNs >= firstHigh.tNs)
      .map((e) => ({ ...e, tNs: e.tNs - firstHigh.tNs }))
      .slice(0, 4);

    // Reference: HIGH@0, LOW@1s, HIGH@2s, LOW@3s (1 Hz square wave).
    const reference: Trace = [
      { tNs: 0, kind: 'gpio', key: '13=1' },
      { tNs: 1_000_000_000, kind: 'gpio', key: '13=0' },
      { tNs: 2_000_000_000, kind: 'gpio', key: '13=1' },
      { tNs: 3_000_000_000, kind: 'gpio', key: '13=0' },
    ];
    const diff = compareTraces(reference, aligned, { timeToleranceNs: 50_000_000 }); // ±50ms
    expect(diff.mismatches, JSON.stringify(diff.mismatches)).toHaveLength(0);
    expect(diff.ok).toBe(true);
  }, 120_000);

  it('uart_echo: every received byte is echoed back on Serial', async () => {
    const fw = await buildCore(`#include <Arduino.h>
void setup(){ Serial.begin(9600); }
void loop(){ if (Serial.available()) Serial.write(Serial.read()); }`);
    const circuit = new Circuit(fw);
    circuit.run(50); // let setup() run
    // Feed one byte at a time, letting the loop read + echo each before the next
    // (the USART RX holds a single byte — bursting would overrun it).
    for (const b of [...'Spark'].map((c) => c.charCodeAt(0))) {
      circuit.runner.serialWrite(b);
      circuit.run(20);
    }

    const recorded: Trace = [...circuit.serial].map((c, i) => ({
      tNs: i,
      kind: 'uart',
      key: `${c.charCodeAt(0)}`,
    }));
    const reference: Trace = [...'Spark'].map((c, i) => ({
      tNs: i,
      kind: 'uart',
      key: `${c.charCodeAt(0)}`,
    }));
    expect(circuit.serial).toContain('Spark');
    expect(compareTraces(reference, recorded, { orderingOnly: true }).ok).toBe(true);
  }, 120_000);
});
