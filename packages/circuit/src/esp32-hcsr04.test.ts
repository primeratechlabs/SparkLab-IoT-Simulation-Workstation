/**
 * HC-SR04 on ESP32 (Xtensa): the firmware's pulseIn reads the model-driven ECHO pulse (root-cause: the SoC clock is now µs-granular so pulseIn no longer arrives mid-echo). Runs a real
 * Xtensa firmware (trig + pulseIn) with the HcSr04 model attached via SocHost, instrumenting the host so
 * we can SEE whether the TRIG watch fires, the ECHO drive happens, and the firmware measures it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { buildEsp32ClassicFirmware } from '@sparklab/build-orchestrator';
import { HcSr04 } from '@sparklab/components-core';
import { XtensaRunner } from '@sparklab/emulators';
import { SocHost } from './soc-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const ESPB = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const WASM_OUT = join(REPO, 'ci', 'toolchain-builder', 'esp32-classic', 'build', 'wasm-out');
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const manifestPath = join(here, '..', '..', 'toolchain-loader', 'src', '__fixtures__', 'esp32-classic-wifi-sdk-manifest.txt');
const runtimeCpp = join(REPO, 'packages', 'emulators', 'src', 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const linkerLd = join(REPO, 'packages', 'emulators', 'src', 'sim-runtime', 'xtensa-flat.ld');
const X = join(ESPB, 'arduino-data', 'packages', 'esp32', 'tools', 'esp-x32', '2601');
const ARCHIVES: [string, string][] = [
  ['/libc.a', join(X, 'picolibc', 'xtensa-esp-elf', 'lib', 'esp32', 'libc.a')],
  ['/libm.a', join(X, 'picolibc', 'xtensa-esp-elf', 'lib', 'esp32', 'libm.a')],
  ['/libgcc.a', join(X, 'picolibc', 'lib', 'gcc', 'xtensa-esp-elf', '14.2.0', 'esp32', 'libgcc.a')],
];
const ready = existsSync(clangMjs) && existsSync(lldMjs) && existsSync(manifestPath) && ARCHIVES.every(([, p]) => existsSync(p));
const sdkBundle = (): ToolInput[] =>
  readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map((rel) => ({ path: join(ESPB, rel), bytes: new Uint8Array(readFileSync(join(ESPB, rel))) }));
const lastNum = (s: string, k: string): number => {
  const m = [...s.matchAll(new RegExp(`${k}=(-?\\d+)(?=\\D)`, 'g'))];
  return m.length ? Number(m[m.length - 1]![1]) : -999;
};

describe.skipIf(!ready)('HC-SR04 on ESP32 (Xtensa) — pulseIn reads the model echo', () => {
  it('the firmware reads the model distance via pulseIn', async () => {
    const clang = (await import(clangMjs)).default;
    const lld = (await import(lldMjs)).default;
    const tc = new WasmRiscvToolchain({ clang, lld });
    const sketch = `#include <Arduino.h>
const int TRIG=25, ECHO=26;
void setup(){ Serial.begin(115200); pinMode(TRIG,OUTPUT); pinMode(ECHO,INPUT); }
void loop(){
  digitalWrite(TRIG,LOW); delayMicroseconds(2);
  digitalWrite(TRIG,HIGH); delayMicroseconds(10); digitalWrite(TRIG,LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  Serial.print("us="); Serial.print(us);
  Serial.print(" dist="); Serial.println(us/58);
  delay(60);
}
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
    expect(built.ok).toBe(true);

    const runner = new XtensaRunner(built.elf!);
    const host = new SocHost(runner);
    const hc = new HcSr04('hc', 25, 26);
    hc.distanceCm = 20; // expect ≈ 20*58 = 1160 µs echo → dist 20
    let trigFires = 0;
    let echoDrives = 0;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const anyHost = host as any;
    const origWatch = anyHost.watchPin.bind(anyHost);
    anyHost.watchPin = (pin: number, cb: (l: string) => void) =>
      origWatch(pin, (l: string) => {
        if (pin === 25 && l === 'high') trigFires++;
        cb(l);
      });
    const origDrive = anyHost.drivePin.bind(anyHost);
    anyHost.drivePin = (pin: number, lvl: string) => {
      if (pin === 26 && lvl === 'high') echoDrives++;
      return origDrive(pin, lvl);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    hc.attach(host); // attach AFTER wrapping so the instrumented watchPin/drivePin are used
    runner.beforeStep = () => host.pump();

    // run several loop iterations so we can confirm the reading is STABLE, not a one-off fluke
    for (let i = 0; i < 400 && (runner.serial().match(/dist=/g)?.length ?? 0) < 3 && !runner.halted; i++)
      runner.executeForMillis(20);
    const s = runner.serial();
    console.log(`HC-SR04 trigFires=${trigFires} echoDrives=${echoDrives} halt=${runner.haltReason ?? 'no'}`);
    console.log('HC-SR04 SERIAL:', s.replace(/\r?\n/g, ' | ').trim().slice(0, 220));
    expect(runner.haltReason).toBeNull();
    expect(trigFires, 'the model must see the TRIG edge').toBeGreaterThanOrEqual(1);
    expect(echoDrives, 'the model must drive the ECHO pulse').toBeGreaterThanOrEqual(1);
    // 20 cm → ~1160 µs echo; the SoC clock is µs-granular so allow ±1 cm of quantisation jitter (real
    // HC-SR04 resolution is ~3 mm anyway). The bug was dist=0 (pulseIn missed the whole echo) — now it reads.
    const us = lastNum(s, 'us');
    expect(us, `echo width µs`).toBeGreaterThan(1080);
    expect(us).toBeLessThan(1240);
    const dist = lastNum(s, 'dist');
    expect(dist).toBeGreaterThanOrEqual(19);
    expect(dist).toBeLessThanOrEqual(21);
  }, 180000);
});
