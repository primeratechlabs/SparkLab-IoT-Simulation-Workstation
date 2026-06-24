/**
 * Integration: the BuildDaemon driving the REAL avr-gcc.wasm toolchain over multi-file
 * projects that pull external libraries — exactly what build.worker.ts does in the
 * browser, but in Node against the gitignored fixtures. Covers Stage 2 acceptance:
 *   • library resolution incl. transitive deps (LCD→Wire, DHT→Adafruit) and the C
 *     file twi.c through cc1 (vs cc1plus);
 *   • a valid linked ELF + Intel HEX;
 *   • incremental rebuild reuses every cached object (invariant I5);
 *   • reproducibility: two independent daemons emit byte-identical firmware (gate #5).
 * Skips when fixtures are absent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MemoryFs, MemoryBuildIndex } from '@sparklab/opfs';
import {
  WasmAvrToolchain,
  WasmTool,
  isValidElf,
  type AvrSdk,
  type EmscriptenModuleFactory,
} from '@sparklab/toolchain-loader';
import { BuildDaemonImpl, type SdkConfig, type ProjectSource } from './daemon.js';
import { randomSketch, compareText } from './differential.js';
import { preprocessSketch } from './arduino-preprocess.js';
import { resolveLibraries, type LibraryCatalogEntry } from './library-resolver.js';
import { scanIncludeDirectives } from './dep-scanner.js';

const here = dirname(fileURLToPath(import.meta.url));
const DST = join(here, '..', '..', 'app', 'public', 'toolchain');
const ready = existsSync(join(DST, 'cc1plus.mjs')) && existsSync(join(DST, 'libraries.json'));

const enc = new TextEncoder();
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const fac = async (n: string): Promise<EmscriptenModuleFactory> =>
  (await import(join(DST, `${n}.mjs`))).default as EmscriptenModuleFactory;

interface LibJson {
  name: string;
  version: string;
  provides: string[];
  depends: string[];
  mount: string;
  includePaths: string[];
  headers: { path: string; b64: string }[];
  sources: { path: string; b64: string; language: 'c' | 'c++' }[];
}

const SDK_CFG: SdkConfig = {
  target: 'avr-atmega328p',
  compilerId: 'avr-gcc-wasm@14.2',
  sdkPackHash: 'sha256:sdk',
  libraryPackHash: 'sha256:libs',
  boardId: 'uno',
  frameworkVersion: 'arduino-avr@1.8.8',
  toolchainPackHash: 'sha256:tc',
};
const ARDUINO_BASE = [
  '-DF_CPU=16000000L',
  '-DARDUINO=10808',
  '-DARDUINO_AVR_UNO',
  '-DARDUINO_ARCH_AVR',
  '-ffunction-sections',
  '-fdata-sections',
];

let toolchain: WasmAvrToolchain;
let objcopy: WasmTool;
let libsJson: LibJson[];
let includeFlags: string[];
let catalog: LibraryCatalogEntry[];

beforeAll(async () => {
  if (!ready) return;
  const sdkJson = JSON.parse(readFileSync(join(DST, 'sdk.json'), 'utf8'));
  libsJson = JSON.parse(readFileSync(join(DST, 'libraries.json'), 'utf8')) as LibJson[];
  const sdk: AvrSdk = {
    headerMounts: [
      ...sdkJson.headerMounts.map(
        (m: { mount: string; files: { path: string; b64: string }[] }) => ({
          mount: m.mount,
          files: m.files.map((f) => ({ path: f.path, bytes: b64(f.b64) })),
        }),
      ),
      ...libsJson.map((l) => ({
        mount: l.mount,
        files: l.headers.map((f) => ({ path: f.path, bytes: b64(f.b64) })),
      })),
    ],
    crt: b64(sdkJson.crt),
    coreA: b64(sdkJson.coreA),
    libs: sdkJson.libs.map((l: { name: string; b64: string }) => ({
      name: l.name,
      bytes: b64(l.b64),
    })),
    ldscript: b64(sdkJson.ldscript),
  };
  toolchain = new WasmAvrToolchain(
    {
      cc1: await fac('cc1'),
      cc1plus: await fac('cc1plus'),
      avrAs: await fac('avr-as'),
      avrLd: await fac('avr-ld'),
    },
    sdk,
  );
  objcopy = new WasmTool(await fac('avr-objcopy'), 'avr-objcopy');
  includeFlags = libsJson.flatMap((l) => l.includePaths.flatMap((p) => ['-I', p]));
  catalog = libsJson.map((l) => ({
    name: l.name,
    version: l.version,
    provides: l.provides,
    architectures: ['avr', '*'],
    depends: l.depends.map((name) => ({ name })),
    srcDir: l.mount,
    headers: l.provides,
  }));
}, 120_000);

function makeDaemon(): { daemon: BuildDaemonImpl; fs: MemoryFs } {
  const fs = new MemoryFs();
  const daemon = new BuildDaemonImpl(fs, new MemoryBuildIndex());
  daemon.setToolchain(toolchain);
  daemon.setProfile('hardware');
  daemon.setBaseFlags([...ARDUINO_BASE, ...includeFlags]);
  daemon.configureSdk(
    SDK_CFG,
    [],
    libsJson.map((l) => ({
      name: l.name,
      version: l.version,
      includePath: l.mount,
      providesHeaders: l.provides,
      architectures: ['avr'],
    })),
  );
  return { daemon, fs };
}

/** Replicates build.worker.ts: resolve libraries → assemble project sources. */
function projectFor(sketch: string): { project: ProjectSource[]; used: string[] } {
  const includes = scanIncludeDirectives(sketch).map((d) => d.name);
  const used = resolveLibraries({ includes, catalog, architecture: 'avr' }).libraries.map(
    (r) => r.name,
  );
  const libSources: ProjectSource[] = libsJson
    .filter((l) => used.includes(l.name))
    .flatMap((l) =>
      l.sources.map((s) => ({ id: s.path, bytes: b64(s.b64), language: s.language })),
    );
  const { cpp } = preprocessSketch([{ name: 'sketch.ino', content: sketch }]);
  return {
    project: [{ id: 'sketch.cpp', bytes: enc.encode(cpp), language: 'c++' }, ...libSources],
    used,
  };
}

async function hexOf(fs: MemoryFs, elfPath: string): Promise<string> {
  const elf = await fs.readFile(elfPath);
  const r = await objcopy.run({
    args: ['-O', 'ihex', '/b.elf', '/b.hex'],
    inputs: [{ path: '/b.elf', bytes: elf }],
    outputs: ['/b.hex'],
  });
  return new TextDecoder().decode(r.outputs.get('/b.hex')!);
}

describe.skipIf(!ready)('BuildDaemon + real avr-gcc.wasm + external libraries', () => {
  it('builds an I2C-LCD sketch (Wire C/C++) and reuses every object on rebuild', async () => {
    const { daemon, fs } = makeDaemon();
    await daemon.start();
    const { project, used } = projectFor(`#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup(){ Serial.begin(9600); lcd.init(); lcd.print("Hi"); }
void loop(){ delay(1000); }`);
    expect(used).toEqual(expect.arrayContaining(['Wire', 'LiquidCrystal_I2C']));
    expect(project.some((s) => s.id.endsWith('.c') && s.language === 'c')).toBe(true); // twi.c via cc1

    daemon.setProject(project);
    const first = await daemon.build();
    expect(first.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(first.compiledUnitIds.length).toBe(project.length);
    const elf = await fs.readFile(first.elfPath!);
    expect(isValidElf(elf)).toBe(true);
    const hex = await hexOf(fs, first.elfPath!);
    expect(hex.trimEnd().endsWith(':00000001FF')).toBe(true);

    const second = await daemon.build();
    expect(second.compiledUnitIds).toHaveLength(0);
    expect(second.reusedUnitIds.length).toBe(project.length);
  }, 180_000);

  it('compiles + links a USER-uploaded library (#include resolves, its source is linked)', async () => {
    // Mirrors build.worker: a parsed .zip → daemon.setUserLibraries + an -I flag + its source in the
    // project. The sketch calls a function defined in the uploaded library; the link must resolve it.
    const { daemon, fs } = makeDaemon();
    const inc = '/userlib/MyMath';
    daemon.setUserLibraries([
      {
        name: 'MyMath',
        version: '1.0.0',
        includePath: inc,
        provides: ['MyMath.h'],
        headers: [{ name: 'MyMath.h', bytes: enc.encode('#pragma once\nint myDouble(int x);\n') }],
      },
    ]);
    daemon.setBaseFlags([...ARDUINO_BASE, ...includeFlags, '-I', inc]);
    await daemon.start();

    const { cpp } = preprocessSketch([
      {
        name: 'sketch.ino',
        content:
          '#include <MyMath.h>\nvoid setup(){ Serial.begin(9600); Serial.println(myDouble(21)); }\nvoid loop(){}',
      },
    ]);
    daemon.setProject([
      { id: 'sketch.cpp', bytes: enc.encode(cpp), language: 'c++' },
      {
        id: `${inc}/MyMath.cpp`,
        bytes: enc.encode('#include "MyMath.h"\nint myDouble(int x){ return x * 2; }\n'),
        language: 'c++',
      },
    ]);
    const out = await daemon.build();
    const err = out.diagnostics.find((d) => d.severity === 'error');
    expect(err, err?.message).toBeUndefined();
    expect(isValidElf(await fs.readFile(out.elfPath!))).toBe(true); // myDouble linked from the uploaded source
  }, 180_000);

  it('resolves a transitive library dependency (DHT → Adafruit Unified Sensor) and compiles', async () => {
    const { daemon, fs } = makeDaemon();
    await daemon.start();
    const { project, used } = projectFor(`#include <DHT.h>
DHT dht(2, DHT22);
void setup(){ Serial.begin(9600); dht.begin(); }
void loop(){ float t = dht.readTemperature(); Serial.println(t); delay(2000); }`);
    expect(used).toEqual(expect.arrayContaining(['DHT', 'Adafruit_Unified_Sensor'])); // transitive

    daemon.setProject(project);
    const out = await daemon.build();
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(isValidElf(await fs.readFile(out.elfPath!))).toBe(true);
  }, 180_000);

  it('links a pulseIn() sketch — core.a ships wiring_pulse.S/countPulseASM (curriculum HC-SR04)', async () => {
    // The exact failure the curriculum retest hit: a standard HC-SR04 sketch using pulseIn(ECHO,HIGH)
    // failed at link with `undefined reference to countPulseASM` because core.a omitted wiring_pulse.S.
    // This builds it end-to-end through the real WASM toolchain — a link error here means the SDK pack
    // regressed to a no-*.S core.a.
    const { daemon, fs } = makeDaemon();
    await daemon.start();
    const { project } = projectFor(`void setup(){ pinMode(7, INPUT); Serial.begin(9600); }
void loop(){ unsigned long us = pulseIn(7, HIGH, 30000UL); Serial.println(us / 58); delay(100); }`);
    daemon.setProject(project);
    const out = await daemon.build();
    const linkErr = out.diagnostics.find((d) => d.severity === 'error');
    expect(
      linkErr,
      linkErr ? `${linkErr.message} (${linkErr.friendly ?? ''})` : '',
    ).toBeUndefined();
    expect(isValidElf(await fs.readFile(out.elfPath!))).toBe(true);
  }, 180_000);

  it('is reproducible: two independent daemons emit byte-identical firmware (gate #5)', async () => {
    const blink = `void setup(){ pinMode(13,OUTPUT); Serial.begin(9600); }
void loop(){ digitalWrite(13,HIGH); Serial.println("on"); delay(500); digitalWrite(13,LOW); delay(500); }`;

    const a = makeDaemon();
    await a.daemon.start();
    a.daemon.setProject(projectFor(blink).project);
    const ra = await a.daemon.build();
    const hexA = await hexOf(a.fs, ra.elfPath!);

    const b = makeDaemon(); // fresh fs + index → no cache shared with A
    await b.daemon.start();
    b.daemon.setProject(projectFor(blink).project);
    const rb = await b.daemon.build();
    const hexB = await hexOf(b.fs, rb.elfPath!);

    expect(ra.compiledUnitIds.length).toBeGreaterThan(0); // both genuinely compiled
    expect(rb.compiledUnitIds.length).toBeGreaterThan(0);
    expect(hexA).toBe(hexB); // input-identical → output byte-identical
    expect(ra.firmwareKey).toBe(rb.firmwareKey); // and the content-addressed key matches
  }, 180_000);

  it('differential fuzzing: random valid sketches build byte-identically on two daemons (codegen determinism)', async () => {
    for (const seed of [1, 2, 3]) {
      const sketch = randomSketch(seed);
      const a = makeDaemon();
      await a.daemon.start();
      a.daemon.setProject(projectFor(sketch).project);
      const ra = await a.daemon.build();
      expect(ra.compiledUnitIds.length, `seed ${seed} should compile`).toBeGreaterThan(0);
      const hexA = await hexOf(a.fs, ra.elfPath!);

      const b = makeDaemon();
      await b.daemon.start();
      b.daemon.setProject(projectFor(sketch).project);
      const rb = await b.daemon.build();
      const hexB = await hexOf(b.fs, rb.elfPath!);

      const diff = compareText(hexA, hexB);
      expect(diff.identical, `seed ${seed} diverged at offset ${diff.firstDiffOffset}`).toBe(true);
      expect(ra.firmwareKey).toBe(rb.firmwareKey);
    }
  }, 180_000);
});
