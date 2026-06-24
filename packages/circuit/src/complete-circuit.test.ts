/**
 * Stage 3 COMPLETE CIRCUIT — the acceptance vertical. A real Arduino sketch compiled
 * 100% client-side drives a full breadboard through the event-driven virtual-time
 * kernel: LED + push-button + potentiometer + I2C LCD (external libs) + DHT22 +
 * HC-SR04. Asserts gate #1 (the whole circuit runs correctly through VTK/bridge/
 * kernel) and gate #2 (timing-critical sensors are wall-speed independent — two runs
 * are byte-identical). Skips when the gitignored toolchain/libraries are absent.
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
import { Led, PushButton, Potentiometer, Dht22, HcSr04, LcdI2c } from '@sparklab/components-core';
import { Circuit } from './circuit.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const USER_LIBS = join(REPO, '.tools', 'arduino-user', 'libraries');
const WIRE = join(
  REPO,
  '.tools',
  'arduino15',
  'packages',
  'arduino',
  'hardware',
  'avr',
  '1.8.8',
  'libraries',
  'Wire',
  'src',
);
const LCD = join(USER_LIBS, 'LiquidCrystal_I2C');
const DHT = join(USER_LIBS, 'DHT_sensor_library');
const LDSCRIPT = join(REPO, 'packages', 'emulators', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(LCD, 'LiquidCrystal_I2C.cpp')) &&
  existsSync(join(WIRE, 'Wire.cpp')) &&
  existsSync(join(DHT, 'DHT.cpp'));

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

interface Source {
  key: string;
  bytes: Uint8Array;
  language?: 'c' | 'c++';
}

/** Compile + link + objcopy a multi-source sketch to firmware bytes (client-side). */
async function buildFirmware(sources: Source[], includeFlags: string[]): Promise<Uint8Array> {
  const libDir = join(SDK_ROOT, 'lib');
  const sdk: AvrSdk = {
    headerMounts: [
      { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
      { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
      { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
      { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
      { mount: '/sdk/wire', files: walk(WIRE) },
      { mount: '/sdk/lcd', files: walk(LCD).filter((f) => f.path.endsWith('.h')) },
      { mount: '/sdk/dht', files: walk(DHT).filter((f) => f.path.endsWith('.h')) },
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
    ...includeFlags,
  ];
  const objs: Uint8Array[] = [];
  for (const s of sources) {
    const r = await tc.compile({
      sourceKey: `sha256:${s.key}`,
      sourceBytes: s.bytes,
      target: 'avr',
      flags,
      includedHeaderHashes: [],
      ...(s.language ? { language: s.language } : {}),
    });
    expect(
      r.diagnostics.filter((d) => d.severity === 'error'),
      `compile ${s.key}`,
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
  const hex = new TextDecoder().decode(oc.FS.readFile('/b.hex'));
  // Parse Intel HEX with the emulator's authoritative parser (handles ELA/EOF records
  // + checksums) rather than a hand-rolled one.
  return parseIntelHex(hex).bytes;
}

function libSources(): Source[] {
  return [
    { key: 'lcd', bytes: readFileSync(join(LCD, 'LiquidCrystal_I2C.cpp')) },
    { key: 'wire', bytes: readFileSync(join(WIRE, 'Wire.cpp')) },
    { key: 'twi', bytes: readFileSync(join(WIRE, 'utility', 'twi.c')), language: 'c' },
    { key: 'dht', bytes: readFileSync(join(DHT, 'DHT.cpp')) },
  ];
}

describe.skipIf(!ready)('Stage 3 — complete circuit through the kernel', () => {
  it('GATE #1: LED + button + pot + I2C LCD + DHT22 all run correctly via VTK/bridge', async () => {
    const sketch = `#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
DHT dht(7, DHT22);
void setup(){
  Serial.begin(9600);
  pinMode(13, OUTPUT);
  pinMode(2, INPUT_PULLUP);
  lcd.init(); lcd.backlight(); lcd.setCursor(0,0); lcd.print("Sparklab");
  dht.begin();
  Serial.println("ready");
}
void loop(){
  int pot = analogRead(A0);
  bool pressed = digitalRead(2) == LOW;
  digitalWrite(13, pressed ? HIGH : LOW);
  float t = dht.readTemperature();
  Serial.print("pot="); Serial.print(pot);
  Serial.print(" t="); Serial.print(t, 1);
  Serial.print(" led="); Serial.println(pressed ? 1 : 0);
  delay(50);
}`;
    const fw = await buildFirmware(
      [{ key: 'sketch', bytes: enc.encode(sketch) }, ...libSources()],
      ['-I/sdk/wire', '-I/sdk/wire/utility', '-I/sdk/lcd', '-I/sdk/dht'],
    );

    const circuit = new Circuit(fw);
    const led = new Led('led', 13);
    const button = new PushButton('btn', 2);
    const pot = new Potentiometer('pot', 0);
    const lcd = new LcdI2c('lcd', 0x27);
    const dht = new Dht22('dht', 7, { tempC: 24.0, humidity: 55.0 });
    circuit.add(led).add(button).add(pot).add(lcd).add(dht);

    pot.setPosition(0.5); // ADC ≈ 512
    // Phase 1 (button released): run until the LCD is up and a full DHT line lands.
    circuit.run(8000, () => lcd.text.includes('Sparklab') && /t=24\.0 led=\d/.test(circuit.serial));

    expect(lcd.text).toContain('Sparklab'); // I2C LCD via external libs
    const potVal = Number(circuit.serial.match(/pot=(\d+)/)?.[1] ?? -1);
    expect(potVal).toBeGreaterThanOrEqual(505);
    expect(potVal).toBeLessThanOrEqual(520); // analogRead reflects the pot divider
    expect(circuit.serial).toMatch(/t=24\.0/); // DHT22 single-wire read decoded
    expect(circuit.serial).toMatch(/led=0/); // button released → LED off
    expect(led.on).toBe(false);
    expect(dht.triggers).toBeGreaterThan(0);

    // Phase 2: press the button → LED reacts (run until a full led=1 line prints).
    button.press();
    circuit.run(600, () => /led=1/.test(circuit.serial));
    expect(led.on).toBe(true);
    expect(circuit.serial).toMatch(/led=1/);

    console.log(
      `\n----- Stage 3 complete circuit -----\n  LCD="${lcd.text}"  pot=${potVal}  DHT triggers=${dht.triggers}  LED→${led.on}`,
    );
  }, 180_000);

  it('GATE #2: timing-critical HC-SR04 is decoded correctly and is wall-speed independent', async () => {
    // Echo measured with micros()+digitalRead (this core.a lacks pulseIn's countPulseASM).
    const sketch = `#include <Arduino.h>
#define TRIG 8
#define ECHO 9
void setup(){
  Serial.begin(9600);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
}
void loop(){
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  unsigned long t0 = micros();
  while (digitalRead(ECHO) == LOW && micros() - t0 < 30000UL) {}
  unsigned long tHigh = micros();
  while (digitalRead(ECHO) == HIGH && micros() - tHigh < 30000UL) {}
  unsigned long dur = micros() - tHigh;
  long cm = dur / 58;
  Serial.print("cm="); Serial.println(cm);
  delay(100);
}`;
    const fw = await buildFirmware([{ key: 'sketch', bytes: enc.encode(sketch) }], []);

    // Run the SAME firmware through two independent circuits; identical virtual-time
    // behaviour ⇒ identical output regardless of how fast the host runs it.
    const runOnce = (): string => {
      const c = new Circuit(fw);
      const sonar = new HcSr04('sonar', 8, 9);
      sonar.distanceCm = 25;
      c.add(sonar);
      c.run(2000, () => (c.serial.match(/cm=\d+/g)?.length ?? 0) >= 3);
      return c.serial;
    };
    const a = runOnce();
    const b = runOnce();

    const dist = Number(a.match(/cm=(\d+)/)?.[1] ?? -1);
    expect(dist).toBeGreaterThanOrEqual(23); // HC-SR04 echo width for 25cm
    expect(dist).toBeLessThanOrEqual(27);
    expect(a).toBe(b); // byte-identical → wall-speed independent (I3)

    console.log(
      `\n----- Stage 3 timing gate -----\n  HC-SR04 cm=${dist}  deterministic=${a === b}`,
    );
  }, 180_000);
});
