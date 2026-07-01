/**
 * I2C READ-back devices end-to-end — Arduino Uno, 100% client-side build. Unlike the LCD/SSD1306 (which
 * the firmware only WRITES to), an RTC and an IMU must RETURN bytes the sketch reads. This compiles a
 * real sketch that drives raw `Wire` register transactions against the DS1307 (0x68) and MPU6050 (0x68)
 * models and asserts the firmware reads the right values back through the emulated TWI → I2C bus →
 * device.read() path. Skips when the gitignored toolchain/Wire library are absent.
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
import { Ds1307, Mpu6050 } from '@sparklab/components-core';
import { Circuit } from './circuit.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
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
const LDSCRIPT = join(REPO, 'packages', 'emulators', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(WIRE, 'Wire.cpp'));

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

async function buildFirmware(sketch: string): Promise<Uint8Array> {
  const libDir = join(SDK_ROOT, 'lib');
  const sdk: AvrSdk = {
    headerMounts: [
      { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
      { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
      { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
      { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
      { mount: '/sdk/wire', files: walk(WIRE) },
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
    '-I/sdk/wire',
    '-I/sdk/wire/utility',
  ];
  const sources: Source[] = [
    { key: 'sketch', bytes: enc.encode(sketch) },
    { key: 'wire', bytes: readFileSync(join(WIRE, 'Wire.cpp')) },
    { key: 'twi', bytes: readFileSync(join(WIRE, 'utility', 'twi.c')), language: 'c' },
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

// Only count a number that is FOLLOWED by a non-digit — a value still being transmitted byte-by-byte over
// the virtual UART (no trailing char yet) is ignored, so we never assert on a half-printed reading.
const lastNum = (serial: string, key: string): number => {
  const m = [...serial.matchAll(new RegExp(`${key}=(-?\\d+)(?=\\D)`, 'g'))];
  return m.length ? Number(m[m.length - 1]![1]) : -1;
};

describe.skipIf(!ready)('I2C read-back devices (Uno, client-side build)', () => {
  it('DS1307: the sketch sets the time over Wire and reads it back, ticking forward', async () => {
    const sketch = `#include <Arduino.h>
#include <Wire.h>
void setup(){
  Serial.begin(9600);
  Wire.begin();
  Wire.beginTransmission(0x68);
  Wire.write(0x00); // register pointer
  Wire.write(0x00); // seconds = 0 (CH=0 → run)
  Wire.write(0x20); // minutes = 20 (BCD)
  Wire.write(0x10); // hours   = 10 (BCD)
  Wire.endTransmission();
  Serial.println("ready");
}
void loop(){
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x68, 3);
  uint8_t b[3]; for (uint8_t i=0;i<3;i++) b[i]=Wire.read();
  Serial.print("s="); Serial.print(b[0]);
  Serial.print(" m="); Serial.print(b[1]);
  Serial.print(" h="); Serial.println(b[2]);
  delay(200);
}`;
    const circuit = new Circuit(await buildFirmware(sketch));
    circuit.add(new Ds1307('rtc'));
    circuit.run(4000, () => lastNum(circuit.serial, 's') >= 2);

    expect(lastNum(circuit.serial, 'm')).toBe(0x20); // minutes BCD 20 read back intact
    expect(lastNum(circuit.serial, 'h')).toBe(0x10); // hours BCD 10 read back intact
    const sec = lastNum(circuit.serial, 's');
    expect(sec).toBeGreaterThanOrEqual(2); // the clock advanced ≥2 s of virtual time
    expect(sec).toBeLessThanOrEqual(9); // (kept < 10 so BCD == decimal)
    console.log(
      `  DS1307: read back m=${lastNum(circuit.serial, 'm')} h=${lastNum(circuit.serial, 'h')}, ticked to s=${sec}`,
    );
  }, 180_000);

  it('MPU6050: WHO_AM_I = 0x68 and Z reads +1g (16384) at rest', async () => {
    const sketch = `#include <Arduino.h>
#include <Wire.h>
void setup(){
  Serial.begin(9600);
  Wire.begin();
  Wire.beginTransmission(0x68);
  Wire.write(0x6B); Wire.write(0x00); // PWR_MGMT_1 = wake
  Wire.endTransmission();
  Wire.beginTransmission(0x68);
  Wire.write(0x75); // WHO_AM_I
  Wire.endTransmission();
  Wire.requestFrom(0x68, 1);
  Serial.print("who="); Serial.println(Wire.read());
}
void loop(){
  Wire.beginTransmission(0x68);
  Wire.write(0x3B); // ACCEL_XOUT_H
  Wire.endTransmission();
  Wire.requestFrom(0x68, 6);
  uint8_t b[6]; for (uint8_t i=0;i<6;i++) b[i]=Wire.read();
  int16_t ax = (int16_t)((b[0]<<8)|b[1]);
  int16_t ay = (int16_t)((b[2]<<8)|b[3]);
  int16_t az = (int16_t)((b[4]<<8)|b[5]);
  Serial.print("ax="); Serial.print(ax);
  Serial.print(" ay="); Serial.print(ay);
  Serial.print(" az="); Serial.println(az);
  delay(200);
}`;
    const circuit = new Circuit(await buildFirmware(sketch));
    circuit.add(new Mpu6050('imu'));
    // wait for ≥2 COMPLETE az lines so the asserted (last complete) reading is fully transmitted.
    circuit.run(3000, () => (circuit.serial.match(/az=-?\d+\r?\n/g)?.length ?? 0) >= 2);

    expect(lastNum(circuit.serial, 'who')).toBe(0x68); // identity register read back
    expect(lastNum(circuit.serial, 'ax')).toBe(0); // level board: no X/Y acceleration
    expect(lastNum(circuit.serial, 'ay')).toBe(0);
    expect(lastNum(circuit.serial, 'az')).toBe(16384); // +1g on Z at rest, ±2g scaling (16-byte burst read)
    console.log(
      `  MPU6050: who=${lastNum(circuit.serial, 'who')} ax=${lastNum(circuit.serial, 'ax')} az=${lastNum(circuit.serial, 'az')}`,
    );
  }, 180_000);
});
