/**
 * External-library showcase: a DHT22 temperature/humidity sketch needing the
 * "DHT sensor library" — which itself DEPENDS on "Adafruit Unified Sensor". Both
 * libraries' .cpp are compiled 100% client-side (WasmAvrToolchain) and linked; a
 * virtual-time DHT22 sensor model (state machine on cpu.cycles, invariant I3)
 * answers the 1-wire read so the firmware prints a REAL reading to Serial.
 * Skips in CI (gitignored toolchain + locally-installed libraries).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { PinState } from 'avr8js';
import {
  WasmAvrToolchain,
  type AvrSdk,
  type SdkFile,
  type EmscriptenModuleFactory,
} from '@sparklab/toolchain-loader';
import { AVRRunner } from './avr-runner.js';
import { parseIntelHex } from './intel-hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const LIBS = join(REPO, '.tools', 'arduino-user', 'libraries');
const DHT = join(LIBS, 'DHT_sensor_library');
const ADAFRUIT = join(LIBS, 'Adafruit_Unified_Sensor');
const LDSCRIPT = join(here, '..', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(DHT, 'DHT.cpp')) &&
  existsSync(join(ADAFRUIT, 'Adafruit_Sensor.cpp'));

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

/** Virtual-time DHT22 model: replies to the MCU's read on the data pin (D2). */
class Dht22Model {
  private prevState = -1;
  private segments: { until: number; level: boolean }[] = [];
  private triggerNs = -1;
  private segIdx = 0;
  triggers = 0;
  constructor(
    private readonly runner: AVRRunner,
    private readonly pin: number,
    tempC: number,
    humidity: number,
  ) {
    const hum = Math.round(humidity * 10);
    const temp = Math.round(tempC * 10);
    const bytes = [(hum >> 8) & 0xff, hum & 0xff, (temp >> 8) & 0xff, temp & 0xff];
    bytes.push(bytes.reduce((a, b) => (a + b) & 0xff, 0)); // checksum
    const us: { dur: number; level: boolean }[] = [
      { dur: 40, level: true }, // line idles high during the MCU's pull-up delay
      { dur: 80, level: false }, // DHT response: 80us LOW
      { dur: 80, level: true }, //               80us HIGH
    ];
    for (const b of bytes) {
      for (let bit = 7; bit >= 0; bit--) {
        us.push({ dur: 50, level: false }); // each bit: 50us LOW
        us.push({ dur: (b >> bit) & 1 ? 70 : 26, level: true }); // HIGH: 70us=1, 26us=0
      }
    }
    us.push({ dur: 50, level: false }); // terminate the final HIGH pulse
    us.push({ dur: 200, level: true }); // release (idle high)
    let t = 0;
    for (const s of us) {
      t += s.dur * 1000; // us → ns
      this.segments.push({ until: t, level: s.level });
    }
  }
  /** Call every instruction while stepping the CPU (us-level 1-wire timing, I3). */
  tick(): void {
    if (this.triggerNs < 0) {
      const state = this.runner.pinState('D', this.pin);
      const isInput = state === PinState.Input || state === PinState.InputPullUp;
      if (this.prevState === PinState.Low && isInput) {
        this.triggerNs = this.runner.virtualTimeNs;
        this.segIdx = 0;
        this.triggers++;
      }
      this.prevState = state;
      return;
    }
    const elapsed = this.runner.virtualTimeNs - this.triggerNs;
    while (this.segIdx < this.segments.length && elapsed >= this.segments[this.segIdx]!.until) {
      this.segIdx++;
    }
    if (this.segIdx >= this.segments.length) {
      this.triggerNs = -1; // reply done; arm for the next read
      this.prevState = -1;
      return;
    }
    this.runner.setDigitalInput(this.pin, this.segments[this.segIdx]!.level);
  }
}

describe.skipIf(!ready)(
  'External library with a dependency (DHT + Adafruit Unified Sensor)',
  () => {
    it('compiles both libraries client-side and reads a virtual DHT22 → Serial', async () => {
      const libDir = join(SDK_ROOT, 'lib');
      const sdk: AvrSdk = {
        headerMounts: [
          { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
          { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
          { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
          { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
          { mount: '/sdk/dht', files: walk(DHT).filter((f) => f.path.endsWith('.h')) },
          { mount: '/sdk/adafruit', files: walk(ADAFRUIT).filter((f) => f.path.endsWith('.h')) },
        ],
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

      const sketch = `#include <Arduino.h>
#include <DHT.h>
DHT dht(2, DHT22);
void setup(){ Serial.begin(9600); dht.begin(); }
void loop(){
  delay(100);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) { Serial.println("DHT read failed"); }
  else { Serial.print("Humidity="); Serial.print(h); Serial.print("% Temp="); Serial.print(t); Serial.println("C"); }
}`;

      // Compile the sketch + BOTH library sources entirely client-side.
      const objs = [];
      for (const src of [
        { key: 'sketch', bytes: enc.encode(sketch) },
        { key: 'dht', bytes: readFileSync(join(DHT, 'DHT.cpp')) },
        { key: 'adafruit', bytes: readFileSync(join(ADAFRUIT, 'Adafruit_Sensor.cpp')) },
      ]) {
        const r = await tc.compile({
          sourceKey: `sha256:${src.key}`,
          sourceBytes: src.bytes,
          target: 'avr',
          // DHT/Adafruit headers added via -I so quote-includes resolve.
          flags: [...flags, '-I/sdk/dht', '-I/sdk/adafruit'],
          includedHeaderHashes: [],
        });
        expect(
          r.diagnostics.filter((d) => d.severity === 'error'),
          `compile ${src.key}`,
        ).toHaveLength(0);
        objs.push(r.object);
      }
      const linked = await tc.link({ objects: objs, target: 'avr', flags: [] });
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
      const { bytes } = parseIntelHex(new TextDecoder().decode(oc.FS.readFile('/b.hex')));

      const runner = new AVRRunner(bytes);
      let serial = '';
      runner.onSerialByte((c) => (serial += String.fromCharCode(c)));
      const dht = new Dht22Model(runner, 2, 23.5, 55.0);
      const readingPattern = /Humidity=[\d.]+% Temp=[\d.]+C/;
      // Step finely so the DHT model can answer the microsecond-level 1-wire protocol.
      for (
        let i = 0;
        i < 6_000_000 && !readingPattern.test(serial) && !/DHT read failed/.test(serial);
        i++
      ) {
        runner.step();
        dht.tick(); // every instruction → accurate microsecond pulses
      }

      const reading = readingPattern.test(serial);
      console.log('\n----- DHT external-library showcase (client-compiled) -----');
      console.log(
        '  DHT sensor library + Adafruit Unified Sensor (dependency): compiled + linked client-side',
      );
      console.log('  firmware runs; 1-wire read sequence executed:', dht.triggers, 'time(s)');
      console.log('  Serial:', serial.split('\n').filter((l) => l.trim())[0] ?? '(none)');
      if (reading) console.log('  decoded reading:', serial.match(/Humidity=.*C/)?.[0]);

      // Core deliverable: the external library AND its transitive dependency compiled
      // 100% client-side, linked, and the firmware decodes a real virtual DHT22 reading.
      expect(reading).toBe(true);
      expect(dht.triggers).toBeGreaterThanOrEqual(1); // the 1-wire read protocol ran
    }, 120_000);
  },
);
