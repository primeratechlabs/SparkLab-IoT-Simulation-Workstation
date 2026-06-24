/**
 * Kitchen-sink CATALOG integration — Arduino Uno. Wires the broadest set of catalog
 * components onto one Uno and drives them with a single non-trivial sketch, compiled
 * 100% client-side and run through the VTK/bridge/kernel. Beyond the original
 * showcase this exercises the NEWLY-ADDED catalog parts, each via the exact runtime
 * model `COMPONENT_CATALOG[type].build()` produces:
 *
 *   LED (D13, 'led')                push-button (D2, 'pushbutton-6mm')
 *   slide-switch (D7, 'slide-switch')   potentiometer (A0, 'potentiometer')
 *   slide-potentiometer (A1, 'slide-potentiometer')
 *   sound sensor (A2, 'small-sound-sensor')
 *   servo (D9, 'servo')             I2C LCD 20x4 (0x27, 'lcd2004', LiquidCrystal_I2C)
 *
 * Complex firmware: a slide-switch selects whether the rotary pot or the slide pot
 * drives the servo angle; the button mirrors onto the LED; the mic crosses a loudness
 * threshold; the 20x4 LCD shows live state; Serial prints structured telemetry. Every
 * device is observed reacting in the SAME firmware run. (led-ring/neopixel-matrix reuse
 * the Ws2812 model — covered by device-runtime + ws2812 decode tests; driving WS2812 from
 * AVR needs a timing-asm NeoPixel lib, out of scope here.) Skips when the gitignored
 * toolchain/libraries are absent.
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
import {
  Led,
  PushButton,
  Potentiometer,
  AnalogSensor,
  DigitalSensor,
  LcdI2c,
  ServoSg90,
} from '@sparklab/components-core';
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
const SERVO = join(USER_LIBS, 'Servo', 'src');
const LDSCRIPT = join(REPO, 'packages', 'emulators', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(LCD, 'LiquidCrystal_I2C.cpp')) &&
  existsSync(join(WIRE, 'Wire.cpp')) &&
  existsSync(join(SERVO, 'avr', 'Servo.cpp'));

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

async function buildFirmware(sources: Source[], includeFlags: string[]): Promise<Uint8Array> {
  const libDir = join(SDK_ROOT, 'lib');
  const sdk: AvrSdk = {
    headerMounts: [
      { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
      { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
      { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
      { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
      { mount: '/sdk/wire', files: walk(WIRE) },
      { mount: '/sdk/servo', files: walk(SERVO) },
      { mount: '/sdk/lcd', files: walk(LCD).filter((f) => f.path.endsWith('.h')) },
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
  return parseIntelHex(new TextDecoder().decode(oc.FS.readFile('/b.hex'))).bytes;
}

function libSources(): Source[] {
  return [
    { key: 'lcd', bytes: readFileSync(join(LCD, 'LiquidCrystal_I2C.cpp')) },
    { key: 'wire', bytes: readFileSync(join(WIRE, 'Wire.cpp')) },
    { key: 'twi', bytes: readFileSync(join(WIRE, 'utility', 'twi.c')), language: 'c' },
    { key: 'servo', bytes: readFileSync(join(SERVO, 'avr', 'Servo.cpp')) },
  ];
}

function lastNum(serial: string, key: string): number {
  const m = [...serial.matchAll(new RegExp(`${key}=(-?\\d+)`, 'g'))];
  return m.length ? Number(m[m.length - 1]![1]) : -1;
}

describe.skipIf(!ready)(
  'Catalog kitchen-sink — Uno: 8 components incl. new catalog parts, one complex sketch',
  () => {
    it('compiles + runs a multi-mode sketch; every catalog device reacts in the same run', async () => {
      const sketch = `#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Servo.h>
LiquidCrystal_I2C lcd(0x27, 20, 4);
Servo myServo;
void setup(){
  Serial.begin(9600);
  pinMode(13, OUTPUT);       // LED ('led')
  pinMode(2, INPUT_PULLUP);  // push-button ('pushbutton-6mm')
  pinMode(7, INPUT_PULLUP);  // slide-switch ('slide-switch')
  myServo.attach(9);         // servo ('servo')
  lcd.init(); lcd.backlight();
  lcd.setCursor(0,0); lcd.print("Sparklab 20x4");
  Serial.println("ready");
}
void loop(){
  int pot   = analogRead(A0);  // potentiometer
  int slide = analogRead(A1);  // slide-potentiometer
  int mic   = analogRead(A2);  // small-sound-sensor
  bool pressed = digitalRead(2) == LOW;
  bool altMode = digitalRead(7) == LOW;  // slide-switch picks the servo source
  int src = altMode ? slide : pot;
  int angle = map(src, 0, 1023, 0, 180);
  myServo.write(angle);
  digitalWrite(13, pressed ? HIGH : LOW);
  bool loud = mic > 600;
  lcd.setCursor(0,1);
  lcd.print("a="); lcd.print(angle); lcd.print(" m="); lcd.print(altMode?1:0); lcd.print("   ");
  Serial.print("pot="); Serial.print(pot);
  Serial.print(" slide="); Serial.print(slide);
  Serial.print(" mic="); Serial.print(mic);
  Serial.print(" mode="); Serial.print(altMode?1:0);
  Serial.print(" ang="); Serial.print(angle);
  Serial.print(" loud="); Serial.print(loud?1:0);
  Serial.print(" led="); Serial.println(pressed?1:0);
  delay(20);
}`;
      const fw = await buildFirmware(
        [{ key: 'kitchensink', bytes: enc.encode(sketch) }, ...libSources()],
        ['-I/sdk/wire', '-I/sdk/wire/utility', '-I/sdk/servo', '-I/sdk/lcd'],
      );

      const circuit = new Circuit(fw);
      // Each device is the SAME runtime model COMPONENT_CATALOG[type].build() yields.
      const led = new Led('led', 13); // catalog 'led'
      const button = new PushButton('btn', 2); // catalog 'pushbutton-6mm'
      const slideSw = new DigitalSensor('sw', 7); // catalog 'slide-switch'
      const pot = new Potentiometer('pot', 0); // catalog 'potentiometer' (A0)
      const slidePot = new Potentiometer('slide', 1); // catalog 'slide-potentiometer' (A1)
      const mic = new AnalogSensor('mic', 2); // catalog 'small-sound-sensor' (A2)
      const servo = new ServoSg90('servo', 9); // catalog 'servo'
      const lcd = new LcdI2c('lcd', 0x27); // catalog 'lcd2004'
      circuit.add(led).add(button).add(slideSw).add(pot).add(slidePot).add(mic).add(servo).add(lcd);

      // Phase 1 — released button, slide-switch HIGH (mode 0 → pot drives the servo), quiet mic.
      pot.setPosition(0.25); // A0 ≈ 256  → angle ≈ 45
      slidePot.setPosition(0.8); // A1 ≈ 819
      mic.setValue(0.3); // A2 ≈ 307  (< 600 → loud=0)
      slideSw.setActive(true); // D7 HIGH → digitalRead==HIGH → altMode=0
      button.release(); // D2 HIGH → not pressed
      circuit.run(
        9000,
        () =>
          lcd.text.includes('Sparklab 20x4') &&
          /led=0/.test(circuit.serial) &&
          lastNum(circuit.serial, 'ang') >= 0,
      );

      expect(lcd.text).toContain('Sparklab 20x4'); // I2C 20x4 LCD (lcd2004 model) via external lib
      expect(lastNum(circuit.serial, 'pot')).toBeGreaterThanOrEqual(245);
      expect(lastNum(circuit.serial, 'pot')).toBeLessThanOrEqual(270); // potentiometer divider read
      expect(lastNum(circuit.serial, 'slide')).toBeGreaterThan(780); // slide-potentiometer read
      expect(lastNum(circuit.serial, 'mic')).toBeGreaterThan(250); // sound sensor analog read
      expect(lastNum(circuit.serial, 'mic')).toBeLessThan(360);
      expect(lastNum(circuit.serial, 'mode')).toBe(0); // slide-switch HIGH → mode 0
      expect(lastNum(circuit.serial, 'loud')).toBe(0); // quiet
      expect(lastNum(circuit.serial, 'led')).toBe(0); // button released
      expect(led.on).toBe(false);
      const angleMode0 = lastNum(circuit.serial, 'ang');
      expect(angleMode0).toBeGreaterThanOrEqual(40);
      expect(angleMode0).toBeLessThanOrEqual(50); // pot 0.25 → ~45° (firmware map())
      expect(servo.pulses).toBeGreaterThan(2); // servo PWM pulses measured
      // NB: the Arduino Servo lib emits 544–2400µs pulses; the ServoSg90 model is calibrated for the
      // 1000–2000µs convention, so its absolute angle differs from the firmware's write(). We assert the
      // physical response is MONOTONIC instead (mode-1's wider source must drive a larger measured angle).
      expect(servo.angleDeg).toBeGreaterThanOrEqual(0); // at least one pulse decoded
      const servoAngle0 = servo.angleDeg;

      // Phase 2 — press button, flip slide-switch LOW (mode 1 → slide pot drives the servo), loud mic.
      button.press(); // D2 LOW → pressed
      slideSw.setActive(false); // D7 LOW → altMode=1, servo now follows the slide pot (~819 → ~144°)
      mic.setValue(0.7); // A2 ≈ 716 (> 600 → loud=1)
      circuit.run(
        900,
        () =>
          /led=1/.test(circuit.serial) &&
          lastNum(circuit.serial, 'mode') === 1 &&
          lastNum(circuit.serial, 'loud') === 1,
      );

      expect(lastNum(circuit.serial, 'led')).toBe(1); // button → LED
      expect(led.on).toBe(true);
      expect(lastNum(circuit.serial, 'mode')).toBe(1); // slide-switch LOW → mode 1
      expect(lastNum(circuit.serial, 'loud')).toBe(1); // mic crossed the loudness threshold
      const angleMode1 = lastNum(circuit.serial, 'ang');
      expect(angleMode1).toBeGreaterThan(130); // slide pot 0.8 → ~144°, distinct from mode-0 ~45°
      expect(angleMode1).toBeGreaterThan(angleMode0);
      expect(servo.angleDeg).toBeGreaterThan(servoAngle0 + 20); // servo physically followed the wider source

      console.log(`\n----- Catalog kitchen-sink (Uno, client-side build) -----`);
      console.log(`  LCD 20x4 text   : "${lcd.text}"  (I2C bytes: ${lcd.bytes})`);
      console.log(
        `  servo angle     : mode0 ${angleMode0}° → mode1 ${angleMode1}°  (model ${servo.angleDeg.toFixed(0)}°, pulses ${servo.pulses})`,
      );
      console.log(
        `  analog reads    : pot=${lastNum(circuit.serial, 'pot')} slide=${lastNum(circuit.serial, 'slide')} mic=${lastNum(circuit.serial, 'mic')}`,
      );
      console.log(
        `  digital         : button→LED ${led.on}, slide-switch mode toggled 0→1, loud ${lastNum(circuit.serial, 'loud')}`,
      );
    }, 180_000);
  },
);
