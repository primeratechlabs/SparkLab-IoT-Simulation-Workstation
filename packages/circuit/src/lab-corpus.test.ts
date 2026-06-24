/**
 * Curriculum lab corpus (docs/TEST-CASES-labs-attached.md) — runs the ACTUAL Lab 01–10 firmware on the
 * Arduino Uno path: each sketch is compiled 100% client-side (avr-gcc.wasm) and executed on avr8js
 * through the VTK/bridge/kernel with the lab's real component models attached, asserting the lab's
 * behaviour (GPIO / ADC / SERIAL / PWM / DISPLAY / interrupt). Proves the simulator handles the course's
 * own labs, not just synthetic circuits. Skips when the gitignored toolchain/libraries are absent.
 *
 * Coverage (10/10): Lab01 (LED+button), Lab02 (IR+pot), Lab03 (7-seg, raw GPIO — SevSeg not vendored),
 * Lab04 (hardware interrupt INT0), Lab05 (Serial echo), Lab06 (servo), Lab07 (PWM fade), Lab08 (L298N
 * direction+speed), Lab09 (Arduino_FreeRTOS — 3 concurrent tasks; the scheduler ticks off the Watchdog
 * interrupt, now wired into AVRRunner), Lab10 (SoftwareSerial bit-bang RX @9600 via PCINT).
 *
 * Vendored libs live under .tools (gitignored, like Servo/SoftwareSerial); Lab09 needs Arduino_FreeRTOS
 * (feilipu/Arduino_FreeRTOS_Library) at .tools/arduino-user/libraries/FreeRTOS/src — each lab `it` skips
 * gracefully if its library is absent, so the suite never hard-fails on a fresh checkout.
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
  DigitalSensor,
  ServoSg90,
  SevenSegment,
} from '@sparklab/components-core';
import { Circuit } from './circuit.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const USER_LIBS = join(REPO, '.tools', 'arduino-user', 'libraries');
const SERVO = join(USER_LIBS, 'Servo', 'src');
const SOFTSERIAL = join(
  REPO,
  '.tools',
  'arduino15',
  'packages',
  'arduino',
  'hardware',
  'avr',
  '1.8.8',
  'libraries',
  'SoftwareSerial',
  'src',
);
const FREERTOS = join(USER_LIBS, 'FreeRTOS', 'src');
const LDSCRIPT = join(REPO, 'packages', 'emulators', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(SERVO, 'avr', 'Servo.cpp')) &&
  existsSync(join(SOFTSERIAL, 'SoftwareSerial.cpp'));
const freertosReady =
  existsSync(join(FREERTOS, 'tasks.c')) && existsSync(join(FREERTOS, 'Arduino_FreeRTOS.h'));

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

/** Compile + link + objcopy a sketch (+ optional libs) to firmware bytes — the same client-side path the app uses. */
async function buildFirmware(sources: Source[], includeFlags: string[]): Promise<Uint8Array> {
  const libDir = join(SDK_ROOT, 'lib');
  const sdk: AvrSdk = {
    headerMounts: [
      { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
      { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
      { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
      { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
      { mount: '/sdk/servo', files: walk(SERVO) },
      { mount: '/sdk/softserial', files: walk(SOFTSERIAL) },
      ...(freertosReady ? [{ mount: '/sdk/freertos', files: walk(FREERTOS) }] : []),
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
const sketch = (key: string, code: string): Source[] => [{ key, bytes: enc.encode(code) }];
const SERVO_SRC: Source = { key: 'servo', bytes: readFileSync(join(SERVO, 'avr', 'Servo.cpp')) };
const SOFTSERIAL_SRC: Source = {
  key: 'softserial',
  bytes: readFileSync(join(SOFTSERIAL, 'SoftwareSerial.cpp')),
};
// The Arduino_FreeRTOS kernel sources (the AVR port ticks off the Watchdog interrupt).
const FREERTOS_SRCS: Source[] = freertosReady
  ? [
      ...[
        'tasks.c',
        'queue.c',
        'list.c',
        'timers.c',
        'event_groups.c',
        'stream_buffer.c',
        'heap_3.c',
        'port.c',
      ].map((f) => ({
        key: `frt-${f}`,
        bytes: readFileSync(join(FREERTOS, f)),
        language: 'c' as const,
      })),
      { key: 'frt-variantHooks', bytes: readFileSync(join(FREERTOS, 'variantHooks.cpp')) },
    ]
  : [];

/**
 * Run the Circuit in bounded virtual-time CHUNKS, yielding to the event loop between each. A single
 * multi-second synchronous `circuit.run()` starves the Vitest worker's RPC under full-suite load (the
 * worker can't answer `onTaskUpdate` → "[vitest-worker]: Timeout") — chunking + yielding keeps the
 * worker responsive without changing the virtual-time semantics (time only advances inside run()).
 */
async function runUntil(c: Circuit, totalMs: number, until?: () => boolean): Promise<void> {
  const CHUNK_MS = 150;
  let done = 0;
  while (done < totalMs) {
    if (until?.()) return;
    const step = Math.min(CHUNK_MS, totalMs - done);
    c.run(step);
    done += step;
    await new Promise((r) => setTimeout(r, 0)); // let the worker breathe (wall time only — virtual time is paused)
  }
}

const BIT_MS = 1000 / 9600; // one 9600-baud bit ≈ 104.17 µs of virtual time
/** Bit-bang one UART byte (8N1, LSB first) onto a pin the firmware reads — start LOW, 8 data bits, stop HIGH. */
async function txByte(c: Circuit, pin: number, b: number): Promise<void> {
  c.drivePin(pin, 'low');
  await runUntil(c, BIT_MS); // start bit
  for (let i = 0; i < 8; i++) {
    c.drivePin(pin, (b >> i) & 1 ? 'high' : 'low');
    await runUntil(c, BIT_MS);
  }
  c.drivePin(pin, 'high');
  await runUntil(c, BIT_MS * 2); // stop bit + idle gap before the next frame
}

describe.skipIf(!ready)('Curriculum lab corpus — real lab firmware on the Uno simulator', () => {
  it('Lab01 — LED blink (D2) + push button (D7 pull-down) → LED (D8)', async () => {
    const fw = await buildFirmware(
      sketch(
        'lab01',
        `#include <Arduino.h>
void setup(){ pinMode(2,OUTPUT); pinMode(8,OUTPUT); pinMode(7,INPUT); Serial.begin(9600); }
void loop(){
  static unsigned long t=0; static bool s=false;
  if (millis()-t >= 1000){ t=millis(); s=!s; digitalWrite(2, s); }   // blink D2 @1s
  bool pressed = digitalRead(7)==HIGH;                                // pull-down: idle LOW, press HIGH
  digitalWrite(8, pressed?HIGH:LOW);
  Serial.print("b="); Serial.println(pressed?1:0);
}`,
      ),
      [],
    );
    const c = new Circuit(fw);
    const led2 = new Led('led2', 2);
    const led8 = new Led('led8', 8);
    const btn = new DigitalSensor('btn', 7); // pull-down button: active(true)=HIGH(pressed), false=LOW(idle)
    c.add(led2).add(led8).add(btn);
    btn.setActive(false); // released
    await runUntil(c, 2600, () => led2.toggles >= 2);
    expect(led2.toggles, 'D2 blinks (periodic toggle)').toBeGreaterThanOrEqual(2);
    expect(led8.on, 'button released → LED8 off').toBe(false);
    btn.setActive(true); // press → D7 HIGH
    await runUntil(c, 300, () => /b=1/.test(c.serial));
    expect(led8.on, 'button pressed → LED8 on').toBe(true);
    expect(c.serial).toMatch(/b=1/);
  }, 120_000);

  it('Lab02 — IR sensor (active-low, D10) → LED (D13) + Serial; potentiometer (A0) analogRead', async () => {
    const fw = await buildFirmware(
      sketch(
        'lab02',
        `#include <Arduino.h>
void setup(){ pinMode(10,INPUT); pinMode(13,OUTPUT); Serial.begin(9600); }
void loop(){
  if (digitalRead(10)==LOW){ digitalWrite(13,HIGH); Serial.println("Obstacle detected!"); }
  else { digitalWrite(13,LOW); Serial.println("No obstacle."); }
  Serial.print("pot="); Serial.println(analogRead(A0));
  delay(100);
}`,
      ),
      [],
    );
    const c = new Circuit(fw);
    const ir = new DigitalSensor('ir', 10); // active(true)=HIGH=no obstacle; false=LOW=obstacle (active-low)
    const led = new Led('led', 13);
    const pot = new Potentiometer('pot', 0);
    c.add(ir).add(led).add(pot);
    ir.setActive(true); // no obstacle (idle HIGH)
    pot.setPosition(0.5); // A0 ≈ 512
    // take a SETTLED reading (the very first analogRead after reset is an ADC-warmup sample, not the divider).
    await runUntil(
      c,
      1200,
      () => (c.serial.match(/pot=\d+/g)?.length ?? 0) >= 4 && /No obstacle/.test(c.serial),
    );
    expect(led.on, 'no obstacle → LED off').toBe(false);
    expect(c.serial).toMatch(/No obstacle/);
    // only COMPLETE lines (a trailing terminator) — the run can stop mid-print, truncating the last value.
    const pots = [...c.serial.matchAll(/pot=(\d+)[\r\n]/g)].map((m) => Number(m[1]));
    const potVal = pots[pots.length - 1]!;
    expect(potVal).toBeGreaterThanOrEqual(500);
    expect(potVal).toBeLessThanOrEqual(525); // analogRead reflects the pot (~512)

    ir.setActive(false); // obstacle → D10 LOW
    await runUntil(c, 400, () => /Obstacle detected!/.test(c.serial));
    expect(led.on, 'obstacle → LED on').toBe(true);
    expect(c.serial).toMatch(/Obstacle detected!/);
  }, 120_000);

  it('Lab03 — 7-segment counts 0→9 (common-cathode, raw GPIO a–g on D9..D3)', async () => {
    // SevSeg is not vendored; drive the segments directly (the model decodes the displayed digit).
    const fw = await buildFirmware(
      sketch(
        'lab03',
        `#include <Arduino.h>
const uint8_t seg[7] = {9,8,7,6,5,4,3};                 // a,b,c,d,e,f,g
const uint8_t pat[10] = {0x3F,0x06,0x5B,0x4F,0x66,0x6D,0x7D,0x07,0x7F,0x6F}; // 0..9 (bit0=a..bit6=g)
void setup(){ for (uint8_t i=0;i<7;i++) pinMode(seg[i],OUTPUT); }
void loop(){
  for (uint8_t d=0; d<10; d++){
    for (uint8_t i=0;i<7;i++) digitalWrite(seg[i], (pat[d]>>i)&1);   // common-cathode: HIGH = lit
    delay(1000);
  }
}`,
      ),
      [],
    );
    const c = new Circuit(fw);
    const segPins = { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, g: 3 };
    const seg = new SevenSegment('seg', segPins, { commonCathode: true });
    c.add(seg);
    await runUntil(c, 200, () => seg.digit === '0'); // first digit
    expect(seg.digit, 'shows 0 first').toBe('0');
    await runUntil(c, 1200, () => seg.digit === '1'); // next digit after ~1s
    expect(seg.digit, 'advances to 1').toBe('1');
  }, 120_000);

  it('Lab04 — hardware interrupt (INT0 on D2, FALLING) toggles LED (D13)', async () => {
    const fw = await buildFirmware(
      sketch(
        'lab04',
        `#include <Arduino.h>
volatile bool state=false;
void onPress(){ state=!state; }
void setup(){ pinMode(2,INPUT_PULLUP); pinMode(13,OUTPUT); attachInterrupt(digitalPinToInterrupt(2), onPress, FALLING); }
void loop(){ digitalWrite(13, state?HIGH:LOW); delay(5); }`,
      ),
      [],
    );
    const c = new Circuit(fw);
    const btn = new PushButton('btn', 2); // INPUT_PULLUP: released HIGH, press LOW (a FALLING edge on D2=INT0)
    const led = new Led('led', 13);
    c.add(btn).add(led);
    await runUntil(c, 200); // settle
    expect(led.on).toBe(false);
    btn.press(); // FALLING edge → ISR toggles state
    await runUntil(c, 200, () => led.on === true);
    expect(led.on, 'INT0 ISR fired on the falling edge → LED toggled ON').toBe(true);
    btn.release();
    await runUntil(c, 100);
    btn.press(); // second falling edge → toggle back OFF
    await runUntil(c, 200, () => led.on === false);
    expect(led.on, 'second ISR toggled the LED back OFF').toBe(false);
  }, 120_000);

  it('Lab05 — Serial echo @9600 (host → firmware → host)', async () => {
    // avr8js USART has no RX FIFO (single data register), so feed a byte, let the firmware read+echo it,
    // then feed the next — exactly how a real terminal paces bytes onto the wire.
    const fw = await buildFirmware(
      sketch(
        'lab05',
        `#include <Arduino.h>
void setup(){ Serial.begin(9600); }
void loop(){ if (Serial.available()){ char ch=Serial.read(); Serial.write(ch); } }`,
      ),
      [],
    );
    const c = new Circuit(fw);
    await runUntil(c, 60);
    for (const ch of '12345') {
      c.runner.serialWrite(ch.charCodeAt(0));
      await runUntil(c, 100); // let the firmware read this byte + echo it before the next arrives
    }
    await runUntil(c, 100);
    expect(c.serial, 'firmware echoed the received bytes').toContain('12345');
  }, 120_000);

  it('Lab06 — Servo sweep 0/90/180 on D9 (Servo library, 50 Hz)', async () => {
    const fw = await buildFirmware(
      [
        ...sketch(
          'lab06',
          `#include <Arduino.h>
#include <Servo.h>
Servo s;
void setup(){ s.attach(9); }
void loop(){ s.write(0); delay(800); s.write(90); delay(800); s.write(180); delay(800); }`,
        ),
        SERVO_SRC,
      ],
      ['-I/sdk/servo'],
    );
    const c = new Circuit(fw);
    const servo = new ServoSg90('servo', 9);
    c.add(servo);
    await runUntil(c, 700, () => servo.pulses > 2);
    expect(servo.pulses, 'servo PWM pulses measured (50 Hz frame)').toBeGreaterThan(2);
    const a0 = servo.angleDeg;
    await runUntil(c, 1700, () => servo.angleDeg > a0 + 20); // sweep toward 180
    expect(servo.angleDeg, 'servo angle advanced as the sketch swept').toBeGreaterThan(a0 + 20);
  }, 120_000);

  it('Lab07 — LED fade (PWM analogWrite on D11)', async () => {
    const fw = await buildFirmware(
      sketch(
        'lab07',
        `#include <Arduino.h>
void setup(){ pinMode(11,OUTPUT); }
void loop(){ for(int b=0;b<=255;b+=5){ analogWrite(11,b); delay(15);} for(int b=255;b>=0;b-=5){ analogWrite(11,b); delay(15);} }`,
      ),
      [],
    );
    const c = new Circuit(fw);
    const led = new Led('led', 11);
    c.add(led);
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 40; i++) {
      await runUntil(c, 100);
      lo = Math.min(lo, led.brightness);
      hi = Math.max(hi, led.brightness);
    }
    expect(hi, 'PWM reaches a bright duty').toBeGreaterThan(0.6);
    expect(lo, 'PWM reaches a dim duty').toBeLessThan(0.4); // the fade spans a wide duty range
  }, 120_000);

  it('Lab08 — L298N direction + speed by joystick (enA=D9 PWM, in1=D4, in2=D5; joyY=A1)', async () => {
    const fw = await buildFirmware(
      sketch(
        'lab08',
        `#include <Arduino.h>
const int enA=9,in1=4,in2=5;
void setup(){ pinMode(enA,OUTPUT); pinMode(in1,OUTPUT); pinMode(in2,OUTPUT); }
void loop(){
  int y=analogRead(A1);
  if (y<470){ digitalWrite(in1,HIGH); digitalWrite(in2,LOW); analogWrite(enA, map(y,470,0,0,255)); }
  else if (y>550){ digitalWrite(in1,LOW); digitalWrite(in2,HIGH); analogWrite(enA, map(y,550,1023,0,255)); }
  else { digitalWrite(in1,LOW); digitalWrite(in2,LOW); analogWrite(enA,0); }
  delay(10);
}`,
      ),
      [],
    );
    const c = new Circuit(fw);
    const enA = new Led('enA', 9); // observe the PWM duty as "brightness"
    const in1 = new Led('in1', 4);
    const in2 = new Led('in2', 5);
    const joyY = new Potentiometer('joyY', 1);
    c.add(enA).add(in1).add(in2).add(joyY);

    joyY.setPosition(0.05); // Y ≈ 51 (< 470) → reverse, near full speed
    await runUntil(c, 400);
    expect(in1.on, 'Y low → in1 HIGH (one direction)').toBe(true);
    expect(in2.on, 'Y low → in2 LOW').toBe(false);
    expect(enA.brightness, 'enA PWM duty > 0 (motor driven)').toBeGreaterThan(0.3);

    joyY.setPosition(0.5); // centre → stop
    await runUntil(c, 400);
    expect(in1.on).toBe(false);
    expect(in2.on).toBe(false);
    expect(enA.brightness, 'centre → enA duty ~0 (stopped)').toBeLessThan(0.05);

    joyY.setPosition(0.95); // Y high (> 550) → forward
    await runUntil(c, 400);
    expect(in2.on, 'Y high → in2 HIGH (other direction)').toBe(true);
    expect(in1.on).toBe(false);
  }, 120_000);

  it('Lab10 — SoftwareSerial (RX=D10, bit-bang @9600) → LED (D8): "1"→on, "0"→off', async () => {
    // The fixed firmware (TC-B10-2-fix); the lab's original code has a known bug (the '0' branch also drives
    // HIGH) — the sim would faithfully run that too, but here we assert the intended behaviour.
    const fw = await buildFirmware(
      [
        ...sketch(
          'lab10',
          `#include <Arduino.h>
#include <SoftwareSerial.h>
SoftwareSerial mySerial(10, 11); // RX=D10, TX=D11
void setup(){ Serial.begin(9600); mySerial.begin(9600); pinMode(8,OUTPUT); }
void loop(){
  if (mySerial.available()){ char ch=mySerial.read(); if(ch=='1') digitalWrite(8,HIGH); else if(ch=='0') digitalWrite(8,LOW); Serial.print("BT:"); Serial.println(ch); }
}`,
        ),
        SOFTSERIAL_SRC,
      ],
      ['-I/sdk/softserial'],
    );
    const c = new Circuit(fw);
    const led = new Led('led', 8);
    c.add(led);
    c.drivePin(10, 'high'); // SoftwareSerial RX idles HIGH
    await runUntil(c, 200);
    await txByte(c, 10, '1'.charCodeAt(0)); // bit-bang '1' onto the SoftwareSerial RX line
    await runUntil(c, 200, () => /BT:1/.test(c.serial));
    expect(c.serial, 'firmware received "1" over the bit-banged SoftwareSerial RX').toMatch(/BT:1/);
    expect(led.on, '"1" → LED D8 on').toBe(true);
    await txByte(c, 10, '0'.charCodeAt(0));
    await runUntil(c, 200, () => /BT:0/.test(c.serial));
    expect(c.serial).toMatch(/BT:0/);
    expect(led.on, '"0" → LED D8 off').toBe(false);
  }, 120_000);

  it.skipIf(!freertosReady)(
    'Lab09 — FreeRTOS: 3 concurrent tasks (blink D8 @200ms + D7 @300ms + serial counter @500ms)',
    async () => {
      // The Arduino_FreeRTOS scheduler runs off the Watchdog-timer interrupt (wired into AVRRunner).
      const fw = await buildFirmware(
        [
          ...sketch(
            'lab09',
            `#include <Arduino.h>
#include <Arduino_FreeRTOS.h>
void TaskBlink8(void *p){ (void)p; pinMode(8,OUTPUT); bool s=false; for(;;){ s=!s; digitalWrite(8,s); vTaskDelay(200/portTICK_PERIOD_MS); } }
void TaskBlink7(void *p){ (void)p; pinMode(7,OUTPUT); bool s=false; for(;;){ s=!s; digitalWrite(7,s); vTaskDelay(300/portTICK_PERIOD_MS); } }
void TaskCount(void *p){ (void)p; int n=0; for(;;){ Serial.print("count="); Serial.println(n++); vTaskDelay(500/portTICK_PERIOD_MS); } }
void setup(){
  Serial.begin(9600);
  xTaskCreate(TaskBlink8,"b8",96,NULL,1,NULL);
  xTaskCreate(TaskBlink7,"b7",96,NULL,1,NULL);
  xTaskCreate(TaskCount,"c",160,NULL,1,NULL);
  vTaskStartScheduler();
}
void loop(){}`,
          ),
          ...FREERTOS_SRCS,
        ],
        ['-I/sdk/freertos'],
      );
      const c = new Circuit(fw);
      const led8 = new Led('led8', 8);
      const led7 = new Led('led7', 7);
      c.add(led8).add(led7);
      // run a few seconds of virtual time: the scheduler interleaves all three tasks at their own rates.
      await runUntil(
        c,
        2800,
        () => led8.toggles >= 6 && led7.toggles >= 4 && /count=3/.test(c.serial),
      );
      expect(led8.toggles, 'task 1 blinks D8 (fast)').toBeGreaterThanOrEqual(6);
      expect(led7.toggles, 'task 2 blinks D7 concurrently at a slower rate').toBeGreaterThanOrEqual(
        4,
      );
      expect(led8.toggles, 'D8 (200 ms) toggles more often than D7 (300 ms)').toBeGreaterThan(
        led7.toggles,
      );
      expect(c.serial, 'task 3 prints an incrementing counter every ~500 ms').toMatch(/count=3/);
    },
    180_000,
  );
});
