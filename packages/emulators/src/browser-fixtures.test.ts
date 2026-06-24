/**
 * Verifies the browser toolchain FIXTURES (packages/app/public/toolchain/*, produced
 * by `pnpm toolchain-fixtures`) are self-consistent: the pruned avr-libc headers + the
 * bundled SDK still compile & link a Blink sketch via the fixture WASM modules, and
 * objcopy emits Intel HEX that boots on avr8js. This is the in-Node proxy for the
 * browser Gate-#1 e2e (the browser adds only the fetch+blob-import layer). Skips when
 * the gitignored fixtures are absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CPU, avrInstruction, AVRIOPort, portBConfig, AVRTimer, timer0Config } from 'avr8js';
import {
  WasmAvrToolchain,
  WasmTool,
  type AvrSdk,
  type EmscriptenModuleFactory,
} from '@sparklab/toolchain-loader';
import { parseIntelHex } from './intel-hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const DST = join(here, '..', '..', 'app', 'public', 'toolchain');
const ready = existsSync(join(DST, 'cc1plus.mjs')) && existsSync(join(DST, 'sdk.json'));

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const fac = async (n: string): Promise<EmscriptenModuleFactory> =>
  (await import(join(DST, `${n}.mjs`))).default as EmscriptenModuleFactory;

describe.skipIf(!ready)('browser toolchain fixtures (pruned SDK)', () => {
  it('compiles + links + objcopies a Blink sketch and the firmware blinks D13', async () => {
    const sdkJson = JSON.parse(readFileSync(join(DST, 'sdk.json'), 'utf8')) as {
      headerMounts: { mount: string; files: { path: string; b64: string }[] }[];
      crt: string;
      coreA: string;
      libs: { name: string; b64: string }[];
      ldscript: string;
    };
    const sdk: AvrSdk = {
      headerMounts: sdkJson.headerMounts.map((m) => ({
        mount: m.mount,
        files: m.files.map((f) => ({ path: f.path, bytes: b64(f.b64) })),
      })),
      crt: b64(sdkJson.crt),
      coreA: b64(sdkJson.coreA),
      libs: sdkJson.libs.map((l) => ({ name: l.name, bytes: b64(l.b64) })),
      ldscript: b64(sdkJson.ldscript),
    };
    const tc = new WasmAvrToolchain(
      {
        cc1: await fac('cc1'),
        cc1plus: await fac('cc1plus'),
        avrAs: await fac('avr-as'),
        avrLd: await fac('avr-ld'),
      },
      sdk,
    );

    // The app build worker preprocesses .ino via preprocessSketch; here we feed the
    // equivalent .cpp directly (Arduino.h + setup/loop defined before use).
    const cpp = `#include <Arduino.h>
void setup(){ pinMode(LED_BUILTIN,OUTPUT); Serial.begin(9600); }
void loop(){ digitalWrite(LED_BUILTIN,HIGH); Serial.println("on"); delay(200);
  digitalWrite(LED_BUILTIN,LOW); delay(200); }`;
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
      sourceBytes: new TextEncoder().encode(cpp),
      target: 'avr',
      flags,
      includedHeaderHashes: [],
    });
    expect(obj.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const linked = await tc.link({ objects: [obj.object], target: 'avr', flags: [] });
    expect(linked.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(linked.elf.length).toBeGreaterThan(0);

    const oc = new WasmTool(await fac('avr-objcopy'), 'avr-objcopy');
    const r = await oc.run({
      args: ['-O', 'ihex', '/b.elf', '/b.hex'],
      inputs: [{ path: '/b.elf', bytes: linked.elf }],
      outputs: ['/b.hex'],
    });
    const { bytes } = parseIntelHex(new TextDecoder().decode(r.outputs.get('/b.hex')!));

    // Run the firmware; D13 = PORTB5 must toggle (Blink).
    const cpu = new CPU(new Uint16Array(bytes.buffer));
    new AVRTimer(cpu, timer0Config);
    const portB = new AVRIOPort(cpu, portBConfig);
    let toggles = 0;
    let prev = 0;
    portB.addListener(() => {
      const v = (portB.pinState(5) === 1 /* HIGH */ ? 1 : 0) as 0 | 1;
      if (v !== prev) toggles++;
      prev = v;
    });
    for (let i = 0; i < 8_000_000 && toggles < 2; i++) {
      avrInstruction(cpu);
      cpu.tick();
    }
    expect(toggles).toBeGreaterThanOrEqual(2); // the LED actually blinked
  }, 120_000);
});
