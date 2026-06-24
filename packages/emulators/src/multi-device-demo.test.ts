/**
 * End-to-end showcase: a multi-peripheral Arduino sketch — LED + Servo (library) +
 * potentiometer + button + Serial — compiled 100% client-side (WasmAvrToolchain,
 * including the Servo library .cpp) and simulated on avr8js with live inputs. Prints
 * the real Serial output. Skips when the gitignored toolchain/Servo artifacts absent.
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
import { AVRRunner } from './avr-runner.js';
import { parseIntelHex } from './intel-hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const SERVO = join(REPO, '.tools', 'arduino-user', 'libraries', 'Servo', 'src');
const LDSCRIPT = join(here, '..', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(BIN, 'avr-as')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(SERVO, 'Servo.h')) &&
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

describe.skipIf(!ready)('Multi-device Arduino project compiled client-side', () => {
  it('LED + Servo (library) + potentiometer + button + Serial, all at once', async () => {
    const lib = join(SDK_ROOT, 'lib');
    const sdk: AvrSdk = {
      headerMounts: [
        { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
        { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
        { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
        { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
        { mount: '/sdk/servo', files: walk(SERVO) }, // Servo library headers
      ],
      crt: readFileSync(join(lib, 'crtatmega328p.o')),
      coreA: readFileSync(join(lib, 'core.a')),
      libs: ['libgcc.a', 'libm.a', 'libc.a', 'libatmega328p.a'].map((name) => ({
        name,
        bytes: readFileSync(join(lib, 'avr5', name)),
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

    const sketch = `#include <Arduino.h>
#include <Servo.h>
Servo myServo;
void setup(){ pinMode(13,OUTPUT); pinMode(2,INPUT_PULLUP); Serial.begin(9600); myServo.attach(9); }
void loop(){
  int pot = analogRead(A0);
  int angle = map(pot,0,1023,0,180);
  myServo.write(angle);
  bool pressed = (digitalRead(2)==LOW);
  digitalWrite(13, pressed?HIGH:LOW);
  Serial.print("pot="); Serial.print(pot);
  Serial.print(" angle="); Serial.print(angle);
  Serial.print(" btn="); Serial.println(pressed?"DOWN":"up");
  delay(50);
}`;
    const baseFlags = [
      '-Os',
      '-ffunction-sections',
      '-fdata-sections',
      '-DF_CPU=16000000L',
      '-DARDUINO=10808',
      '-DARDUINO_AVR_UNO',
      '-DARDUINO_ARCH_AVR',
    ];

    // Compile the sketch AND the Servo library source — both client-side.
    const sk = await tc.compile({
      sourceKey: 'sha256:sk',
      sourceBytes: enc.encode(sketch),
      target: 'avr',
      flags: baseFlags,
      includedHeaderHashes: [],
    });
    expect(sk.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const servo = await tc.compile({
      sourceKey: 'sha256:servo',
      sourceBytes: readFileSync(join(SERVO, 'avr', 'Servo.cpp')),
      target: 'avr',
      flags: baseFlags,
      includedHeaderHashes: [],
    });
    expect(servo.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    const linked = await tc.link({ objects: [sk.object, servo.object], target: 'avr', flags: [] });
    expect(linked.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    // ELF → HEX → simulate with live peripherals.
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
    let led = 0;
    let servoEdges = 0;
    let lastServo = 0;
    runner.onSerialByte((c) => (serial += String.fromCharCode(c)));
    runner.addGpioListener('B', (v) => {
      led = (v >> 5) & 1; // D13
      const s = (v >> 1) & 1; // D9 servo pulse (Timer1 OC1A)
      if (s !== lastServo) {
        lastServo = s;
        servoEdges++;
      }
    });

    runner.setAnalogVoltage(0, 2.5); // potentiometer at mid (~512)
    runner.setDigitalInput(2, true); // button released (INPUT_PULLUP reads HIGH)
    runner.execute(10_000_000); // ~0.6s virtual

    runner.setAnalogVoltage(0, 4.5); // turn the pot up (~921)
    runner.setDigitalInput(2, false); // press the button (reads LOW)
    runner.execute(10_000_000);

    const lines = serial.split('\n').filter((l) => l.includes('pot='));
    // Showcase: print the live Serial output.
    console.log('\n----- Serial Monitor (real client-compiled firmware) -----');
    console.log(lines.slice(0, 4).join('\n'));
    console.log('...');
    console.log(lines.slice(-4).join('\n'));
    console.log(
      `LED(D13)=${led ? 'ON' : 'off'}  ServoPWM(D9) edges=${servoEdges}  Serial lines=${lines.length}`,
    );

    // Assertions: every device participated.
    expect(lines.length).toBeGreaterThan(3); // Serial streaming the loop
    expect(serial).toContain('btn=DOWN'); // button press registered
    expect(serial).toContain('btn=up'); // and release
    expect(led).toBe(1); // LED ON while button held
    expect(servoEdges).toBeGreaterThan(2); // servo library driving PWM pulses
    // The pot value changed between the two phases (mid → high).
    const pots = lines.map((l) => Number(l.match(/pot=(\d+)/)?.[1] ?? -1)).filter((n) => n >= 0);
    expect(Math.max(...pots)).toBeGreaterThan(Math.min(...pots) + 100);
  }, 120_000);
});
