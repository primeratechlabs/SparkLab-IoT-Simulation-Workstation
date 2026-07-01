/**
 * SPI devices end-to-end — Arduino Uno, 100% client-side build. Proves the new SPI bus (avr8js AVRSPI →
 * SpiBus → device) by compiling real sketches that drive the hardware `SPI` library: one draws a pixel to
 * the ILI9341 TFT (we read it back out of the framebuffer), one runs the SD-over-SPI init handshake and
 * reads block 0 of the microSD card, so the firmware sees the FAT16 boot signature. Skips when the
 * gitignored toolchain / SPI library are absent.
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
import { Ili9341, MicroSdCard } from '@sparklab/components-core';
import { Circuit } from './circuit.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const OUT = join(REPO, 'ci', 'toolchain-builder', 'out');
const BIN = join(OUT, 'binutils');
const GCC = join(OUT, 'gcc');
const SDK_ROOT = join(OUT, 'arduino-avr-core');
const SPI = join(
  REPO,
  '.tools',
  'arduino15',
  'packages',
  'arduino',
  'hardware',
  'avr',
  '1.8.8',
  'libraries',
  'SPI',
  'src',
);
const LDSCRIPT = join(REPO, 'packages', 'emulators', 'test-fixtures', 'avr5-ld.x');

const ready =
  existsSync(join(GCC, 'cc1plus')) &&
  existsSync(join(SDK_ROOT, 'lib', 'core.a')) &&
  existsSync(join(SPI, 'SPI.cpp'));

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

async function buildFirmware(sketch: string): Promise<Uint8Array> {
  const libDir = join(SDK_ROOT, 'lib');
  const sdk: AvrSdk = {
    headerMounts: [
      { mount: '/sdk/core', files: walk(join(SDK_ROOT, 'headers', 'core')) },
      { mount: '/sdk/variant', files: walk(join(SDK_ROOT, 'headers', 'variant')) },
      { mount: '/sdk/avr-libc', files: walk(join(SDK_ROOT, 'headers', 'avr-libc')) },
      { mount: '/sdk/gcc', files: walk(join(SDK_ROOT, 'headers', 'gcc')) },
      { mount: '/sdk/spi', files: walk(SPI) },
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
    '-I/sdk/spi',
  ];
  const sources = [
    { key: 'sketch', bytes: enc.encode(sketch) },
    { key: 'spi', bytes: readFileSync(join(SPI, 'SPI.cpp')) },
  ];
  const objs: Uint8Array[] = [];
  for (const s of sources) {
    const r = await tc.compile({
      sourceKey: `sha256:${s.key}`,
      sourceBytes: s.bytes,
      target: 'avr',
      flags,
      includedHeaderHashes: [],
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

const lastNum = (serial: string, key: string): number => {
  const m = [...serial.matchAll(new RegExp(`${key}=(-?\\d+)(?=\\D)`, 'g'))];
  return m.length ? Number(m[m.length - 1]![1]) : -1;
};

describe.skipIf(!ready)('SPI devices (Uno, client-side build)', () => {
  it('ILI9341: a sketch draws an RGB565 pixel over hardware SPI', async () => {
    const sketch = `#include <Arduino.h>
#include <SPI.h>
#define CS 10
#define DC 9
static void wc(uint8_t c){ digitalWrite(DC,LOW); SPI.transfer(c); }
static void wd(uint8_t d){ digitalWrite(DC,HIGH); SPI.transfer(d); }
void setup(){
  Serial.begin(9600);
  pinMode(CS,OUTPUT); pinMode(DC,OUTPUT); digitalWrite(CS,HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CS,LOW);
  wc(0x2A); wd(0);wd(5);wd(0);wd(5);   // CASET x=5..5
  wc(0x2B); wd(0);wd(5);wd(0);wd(5);   // PASET y=5..5
  wc(0x2C); wd(0xF8);wd(0x00);         // RAMWR one red pixel (RGB565 0xF800)
  digitalWrite(CS,HIGH);
  SPI.endTransaction();
  Serial.println("done");
}
void loop(){}`;
    const circuit = new Circuit(await buildFirmware(sketch));
    const tft = new Ili9341('tft', 10, 9);
    circuit.add(tft);
    circuit.run(500, () => /done/.test(circuit.serial));

    expect(tft.pixelAt(5, 5)).toBe(0xf800); // the firmware really drew the pixel through the SPI bus
    expect(tft.litPixels).toBe(1);
    console.log(
      `  ILI9341: firmware drew ${tft.litPixels} pixel, (5,5)=0x${tft.pixelAt(5, 5).toString(16)}`,
    );
  }, 180_000);

  it('microSD: SD-SPI init + block-0 read sees the FAT16 boot signature', async () => {
    const sketch = `#include <Arduino.h>
#include <SPI.h>
#define CS 4
static uint8_t sdcmd(uint8_t idx, uint32_t arg){
  digitalWrite(CS,LOW);
  SPI.transfer(0x40|idx);
  SPI.transfer(arg>>24); SPI.transfer(arg>>16); SPI.transfer(arg>>8); SPI.transfer(arg);
  SPI.transfer(0x95);
  uint8_t r=0xff; for(uint8_t i=0;i<8 && (r&0x80);i++) r=SPI.transfer(0xff);
  return r;
}
void setup(){
  Serial.begin(9600);
  pinMode(CS,OUTPUT); digitalWrite(CS,HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  uint8_t r0=sdcmd(0,0); digitalWrite(CS,HIGH);
  sdcmd(55,0); digitalWrite(CS,HIGH);
  uint8_t r41=sdcmd(41,0x40000000); digitalWrite(CS,HIGH);
  uint8_t r17=sdcmd(17,0);   // read block 0 (CS stays LOW through the data phase)
  uint8_t tok=0xff; for(uint8_t i=0;i<30 && tok!=0xFE;i++) tok=SPI.transfer(0xff);
  uint8_t b0=0,b1=0;
  for(int i=0;i<512;i++){ uint8_t v=SPI.transfer(0xff); if(i==510)b0=v; if(i==511)b1=v; }
  SPI.transfer(0xff); SPI.transfer(0xff);
  digitalWrite(CS,HIGH);
  SPI.endTransaction();
  Serial.print("r0="); Serial.print(r0);
  Serial.print(" r41="); Serial.print(r41);
  Serial.print(" r17="); Serial.print(r17);
  Serial.print(" tok="); Serial.print(tok);
  Serial.print(" sig="); Serial.print((uint16_t)((b0<<8)|b1));
  Serial.println(" .");
}
void loop(){}`;
    const circuit = new Circuit(await buildFirmware(sketch));
    circuit.add(new MicroSdCard('sd', 4));
    circuit.run(500, () => /sig=\d+ \./.test(circuit.serial));

    expect(lastNum(circuit.serial, 'r0')).toBe(0x01); // card idle after CMD0
    expect(lastNum(circuit.serial, 'r41')).toBe(0x00); // ready after ACMD41
    expect(lastNum(circuit.serial, 'r17')).toBe(0x00); // read accepted
    expect(lastNum(circuit.serial, 'tok')).toBe(0xfe); // data token
    expect(lastNum(circuit.serial, 'sig')).toBe(0x55aa); // FAT16 boot signature
    console.log(`  microSD: ${circuit.serial.trim().split('\n').pop()}`);
  }, 180_000);
});
