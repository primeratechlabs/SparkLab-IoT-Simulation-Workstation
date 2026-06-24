/**
 * Kitchen-sink multi-device showcase — common to slightly-rare peripherals AND two
 * external libraries on ONE Arduino Uno, compiled 100% client-side and run together
 * on avr8js: LED (D13) + push-button (D2) + potentiometer (A0) + Servo (D9, Servo
 * library, Timer1) + I2C 16x2 LCD (0x27, LiquidCrystal_I2C → Wire incl. twi.c) +
 * Serial. Verifies each device responds in the same firmware run. Skips when the
 * gitignored toolchain/libraries are absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { AVRTWI, twiConfig, PinState, type TWIEventHandler } from 'avr8js';
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
const LDSCRIPT = join(here, '..', 'test-fixtures', 'avr5-ld.x');

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

/** PCF8574 (0x27) + HD44780 4-bit model: reconstructs the text the sketch displays. */
class VirtualI2cLcd implements TWIEventHandler {
  text = '';
  bytes = 0;
  private addr = 0;
  private writing = false;
  private prevE = 0;
  private pendingHigh: number | null = null;
  constructor(private readonly twi: AVRTWI) {}
  start(): void {
    this.twi.completeStart();
  }
  stop(): void {
    this.twi.completeStop();
  }
  connectToSlave(addr: number, write: boolean): void {
    this.addr = addr;
    this.writing = write;
    this.twi.completeConnect(addr === 0x27);
  }
  readByte(): void {
    this.twi.completeRead(0xff);
  }
  writeByte(value: number): void {
    this.twi.completeWrite(this.addr === 0x27);
    if (this.addr !== 0x27 || !this.writing) return;
    this.bytes++;
    const e = (value >> 2) & 1;
    if (this.prevE === 1 && e === 0) {
      const nibble = (value >> 4) & 0x0f;
      const rs = value & 1;
      if (rs === 1) {
        if (this.pendingHigh === null) this.pendingHigh = nibble;
        else {
          this.text += String.fromCharCode((this.pendingHigh << 4) | nibble);
          this.pendingHigh = null;
        }
      } else this.pendingHigh = null;
    }
    this.prevE = e;
  }
}

describe.skipIf(!ready)('Multi-device Uno: LED + button + pot + Servo + I2C LCD + Serial', () => {
  it('compiles two external libraries + sketch client-side and every device responds', async () => {
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
    const inc = ['-I/sdk/wire', '-I/sdk/wire/utility', '-I/sdk/servo', '-I/sdk/lcd'];
    const flags = [
      '-Os',
      '-ffunction-sections',
      '-fdata-sections',
      '-DF_CPU=16000000L',
      '-DARDUINO=10808',
      '-DARDUINO_AVR_UNO',
      '-DARDUINO_ARCH_AVR',
      ...inc,
    ];

    const sketch = `#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Servo.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo myServo;
void setup(){
  Serial.begin(9600);
  pinMode(13, OUTPUT);
  pinMode(2, INPUT_PULLUP);
  myServo.attach(9);
  lcd.init(); lcd.backlight();
  lcd.setCursor(0,0); lcd.print("Sparklab");
  Serial.println("ready");
}
void loop(){
  int pot = analogRead(A0);
  int angle = map(pot, 0, 1023, 0, 180);
  myServo.write(angle);
  bool pressed = digitalRead(2) == LOW;
  digitalWrite(13, pressed ? HIGH : LOW);
  Serial.print("pot="); Serial.print(pot);
  Serial.print(" angle="); Serial.println(angle);
  delay(20);
}`;

    const sources: { key: string; bytes: Uint8Array; language?: 'c' | 'c++' }[] = [
      { key: 'sketch', bytes: enc.encode(sketch) },
      { key: 'lcd', bytes: readFileSync(join(LCD, 'LiquidCrystal_I2C.cpp')) },
      { key: 'wire', bytes: readFileSync(join(WIRE, 'Wire.cpp')) },
      { key: 'twi', bytes: readFileSync(join(WIRE, 'utility', 'twi.c')), language: 'c' },
      { key: 'servo', bytes: readFileSync(join(SERVO, 'avr', 'Servo.cpp')) },
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
    const { bytes } = parseIntelHex(new TextDecoder().decode(oc.FS.readFile('/b.hex')));

    // Run all devices together on one Uno.
    const runner = new AVRRunner(bytes);
    const twi = new AVRTWI(runner.cpu, twiConfig, 16_000_000);
    const lcd = new VirtualI2cLcd(twi);
    twi.eventHandler = lcd;

    let serial = '';
    runner.onSerialByte((b) => (serial += String.fromCharCode(b)));
    let servoEdges = 0;
    let lastServo = 0;
    let ledHighSeen = false;
    runner.addGpioListener('B', () => {
      const servo = runner.pinState('B', 1) === PinState.High ? 1 : 0; // D9 = PB1 servo pulse
      if (servo !== lastServo) {
        lastServo = servo;
        servoEdges++;
      }
      if (runner.pinState('B', 5) === PinState.High) ledHighSeen = true; // D13 = PB5 LED
    });

    const potValues = (): number[] =>
      serial
        .split('\n')
        .map((l) => Number(l.match(/pot=(\d+)/)?.[1] ?? -1))
        .filter((n) => n >= 0);

    runner.setDigitalInput(2, true); // button released (INPUT_PULLUP = HIGH)
    runner.setAnalogVoltage(0, 2.5); // pot mid (~512)

    // Phase 1: let the LCD finish its (~1–2s) HD44780 init while the rest runs.
    for (let ms = 0; ms < 2500 && !lcd.text.includes('Sparklab'); ms += 50)
      runner.executeForMillis(50);
    const midPots = potValues();

    // Phase 2: press the button → firmware reads D2 LOW → drives the D13 LED HIGH.
    runner.setDigitalInput(2, false);
    runner.setAnalogVoltage(0, 4.5); // turn the pot up (~921)
    for (let ms = 0; ms < 400; ms += 50) runner.executeForMillis(50);

    const allPots = potValues();
    console.log(`\n----- Multi-device Uno (Servo + I2C LCD libs compiled client-side) -----`);
    console.log(`  LCD display     : "${lcd.text}"  (I2C bytes: ${lcd.bytes})`);
    console.log(`  Servo PWM edges : ${servoEdges} on D9`);
    console.log(`  LED D13 went HIGH on button press: ${ledHighSeen}`);
    console.log(`  pot reads (mid→high): ${midPots.at(-1)} → ${allPots.at(-1)}`);

    expect(lcd.text).toContain('Sparklab'); // I2C LCD library works
    expect(lcd.bytes).toBeGreaterThan(0);
    expect(servoEdges).toBeGreaterThan(2); // Servo library driving PWM pulses
    expect(ledHighSeen).toBe(true); // button → digitalRead → LED reacted
    expect(midPots.at(-1)!).toBeGreaterThan(400); // analogRead reflects the pot (~512)
    expect(midPots.at(-1)!).toBeLessThan(650);
    expect(allPots.at(-1)!).toBeGreaterThan(midPots.at(-1)!); // pot increase shows in Serial
  }, 180_000);
});
