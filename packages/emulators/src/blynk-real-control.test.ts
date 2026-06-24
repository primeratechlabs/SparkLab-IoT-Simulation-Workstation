/**
 * Credential-gated REPRODUCTION of the user's exact symptom: a Blynk dashboard SWITCH on V0 should drive
 * the ESP32 LED on GPIO2 through the FULL firmware path — firmware Blynk.run() → GET /external/api/get?V0
 * over the REAL Tier2Network (global fetch → blynk.cloud) → BLYNK_WRITE(V0) → digitalWrite(2) → C3Gpio.
 *
 * Skips unless BLYNK_TOKEN is in the environment (so no secret is ever committed/needed in CI):
 *   BLYNK_TOKEN=xxxx pnpm vitest run packages/emulators/src/blynk-real-control.test.ts
 * Set the V0 switch on your dashboard to the level you expect, then this asserts GPIO2 follows it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { Tier2Network } from '@sparklab/network-shim';
import { Rv32Cpu, SimpleBus, Rv32Trap } from './rv32.js';
import {
  C3Gpio,
  C3Uart,
  C3Adc,
  C3SysTimer,
  C3_GPIO_BASE,
  C3_UART0_BASE,
  C3_ADC_BASE,
  C3_SYSTIMER_BASE,
} from './esp32c3-soc.js';
import { C3Net, C3_NET_BASE } from './net-sim.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const BUILD = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const WASM_OUT = join(BUILD, 'wasm-out');
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const fixtures = join(here, '..', '..', 'toolchain-loader', 'src', '__fixtures__');
const wifiManifestPath = join(fixtures, 'c3-wifi-sdk-manifest.txt');
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const sparkNetDir = join(here, '__fixtures__', 'SparkNet');
const sparkBlynkDir = join(here, '__fixtures__', 'SparkBlynk');
const PKG = join(BUILD, 'arduino-data', 'packages', 'esp32');
const GCC = join(PKG, 'tools', 'esp-rv32', '2601');
const C3 = join(PKG, 'tools', 'esp32c3-libs', '3.3.10');
const CORE = join(PKG, 'hardware', 'esp32', '3.3.10');
const CXX = `${GCC}/riscv32-esp-elf/include/c++/14.2.0`;
const LIBS = join(CORE, 'libraries');
const TOKEN = process.env.BLYNK_TOKEN;
const EXPECT = (process.env.BLYNK_V0 ?? '1') === '1' ? 1 : 0; // the level you set the V0 switch to
const ready =
  !!TOKEN &&
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(wifiManifestPath) &&
  existsSync(GCC) &&
  existsSync(join(sparkBlynkDir, 'SparkBlynk.h'));

const headerEnv = [
  `--gcc-toolchain=${GCC}`,
  `--sysroot=${GCC}/riscv32-esp-elf`,
  '-stdlib=libstdc++',
  '-nobuiltininc',
  '-isystem',
  `${GCC}/lib/gcc/riscv32-esp-elf/14.2.0/include`,
  '-isystem',
  CXX,
  '-isystem',
  `${CXX}/riscv32-esp-elf/rv32imc_zicsr_zifencei/ilp32`,
  '-isystem',
  `${CXX}/backward`,
  '-isystem',
  `${GCC}/riscv32-esp-elf/include`,
];
const target = ['--target=riscv32-esp-elf', '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'];
const sketchArgs = (): string[] => [
  ...target,
  ...headerEnv,
  '-Qunused-arguments',
  '-w',
  '-c',
  '-Os',
  '-fno-rtti',
  '-fno-exceptions',
  '-ffunction-sections',
  '-fdata-sections',
  '-std=gnu++2a',
  '-DF_CPU=160000000L',
  '-DARDUINO=10607',
  '-DARDUINO_ESP32C3_DEV',
  '-DARDUINO_ARCH_ESP32',
  '-DESP32=ESP32',
  '-DARDUINO_USB_MODE=1',
  '-DARDUINO_USB_CDC_ON_BOOT=0',
  '-DCORE_DEBUG_LEVEL=0',
  `@${C3}/flags/defines`,
  '-iprefix',
  `${C3}/include/`,
  `@${C3}/flags/includes`,
  `-I${C3}/qio_qspi/include`,
  `-I${CORE}/cores/esp32`,
  `-I${CORE}/variants/esp32c3`,
  `-I${LIBS}/WiFi/src`,
  `-I${LIBS}/Network/src`,
  `-I${LIBS}/NetworkClientSecure/src`,
  `-I${LIBS}/FS/src`,
  `-I${sparkNetDir}`,
  `-I${sparkBlynkDir}`,
];
const runtimeArgs = (): string[] => [
  ...target,
  '-nostdlib',
  '-ffreestanding',
  '-ffunction-sections',
  '-fdata-sections',
  '-fno-exceptions',
  '-fno-rtti',
  '-std=gnu++2a',
  '-Os',
  '-c',
];
function sdkBundle(): ToolInput[] {
  const sdk = readFileSync(wifiManifestPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((rel) => ({
      path: join(BUILD, rel),
      bytes: new Uint8Array(readFileSync(join(BUILD, rel))),
    }));
  const spark = [
    {
      path: join(sparkNetDir, 'SparkNet.h'),
      bytes: new Uint8Array(readFileSync(join(sparkNetDir, 'SparkNet.h'))),
    },
    ...readdirSync(sparkBlynkDir)
      .filter((f) => f.endsWith('.h'))
      .map((f) => ({
        path: join(sparkBlynkDir, f),
        bytes: new Uint8Array(readFileSync(join(sparkBlynkDir, f))),
      })),
  ];
  return [...sdk, ...spark];
}
function elfLoad(elf: Uint8Array): { entry: number; segs: { addr: number; data: Uint8Array }[] } {
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const phoff = v.getUint32(28, true),
    phes = v.getUint16(42, true),
    phn = v.getUint16(44, true);
  const segs: { addr: number; data: Uint8Array }[] = [];
  for (let i = 0; i < phn; i++) {
    const p = phoff + i * phes;
    if (v.getUint32(p, true) !== 1) continue;
    const off = v.getUint32(p + 4, true),
      vaddr = v.getUint32(p + 8, true),
      filesz = v.getUint32(p + 16, true);
    if (filesz > 0) segs.push({ addr: vaddr, data: elf.slice(off, off + filesz) });
  }
  return { entry: v.getUint32(24, true), segs };
}

const blynkControlSketch = (token: string): string =>
  '#include <WiFi.h>\n#include <SparkBlynk.h>\n' +
  '#define LED 2\n' +
  'BLYNK_WRITE(V0){ digitalWrite(LED, param.asInt() ? HIGH : LOW); }\n' +
  'void setup(){\n' +
  '  Serial.begin(115200);\n  pinMode(LED, OUTPUT);\n' +
  '  WiFi.begin("Sparklab-GUEST", "");\n  while (WiFi.status() != WL_CONNECTED) { delay(100); }\n' +
  '  Serial.println("WiFi connected");\n' +
  `  Blynk.begin("${token}");\n` +
  '  Serial.println("Blynk ready");\n}\n' +
  'void loop(){ Blynk.run(); delay(50); }\n';

describe.skipIf(!ready)(
  'Blynk dashboard→device — REAL cloud, full firmware path (credential-gated)',
  () => {
    it('a dashboard V0 switch drives GPIO2 through the real Tier-2 polling path', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const sdk = sdkBundle();
      const sk = await tc.compile({
        args: sketchArgs(),
        sdk,
        sourcePath: '/sketch/app.cpp',
        sourceBytes: blynkControlSketch(TOKEN!),
      });
      if (sk.diagnostics.some((d) => d.severity === 'error'))
        throw new Error('sketch compile: ' + JSON.stringify(sk.diagnostics));
      const rt = await tc.compile({
        args: runtimeArgs(),
        sdk: [],
        sourcePath: '/rt.cpp',
        sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
      });
      if (rt.diagnostics.some((d) => d.severity === 'error'))
        throw new Error('runtime compile: ' + JSON.stringify(rt.diagnostics));
      const lk = await tc.link({
        args: ['-Ttext=0', '-e', '_start', '--gc-sections', '/sketch.o', '/rt.o'],
        inputs: [
          { path: '/sketch.o', bytes: sk.object },
          { path: '/rt.o', bytes: rt.object },
        ],
        outPath: '/fw.elf',
      });
      if (lk.diagnostics.some((d) => d.severity === 'error'))
        throw new Error('link: ' + JSON.stringify(lk.diagnostics));

      // Real Tier-2 transport: the firmware's HTTP HAL goes over the runtime's global fetch → blynk.cloud.
      const transport = new Tier2Network({}); // global fetch, real Internet
      const { entry, segs } = elfLoad(lk.output);
      const bus = new SimpleBus(new Uint8Array(0x100000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const cpu = new Rv32Cpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, new C3Adc());
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(transport));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(2, 0xf0000);

      // Run many batches, yielding so each async GET to blynk.cloud resolves. Stop once GPIO2 matches.
      let matched = false;
      for (let batch = 0; batch < 400 && !matched; batch++) {
        let trapped = false;
        for (let k = 0; k < 200_000; k++) {
          try {
            cpu.step();
          } catch (e) {
            if (e instanceof Rv32Trap) {
              trapped = true;
              break;
            }
            throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 5)); // let the pending blynk.cloud fetch resolve
        if (gpio.level(2) === EXPECT && uart.text().includes('Blynk ready')) matched = true;
        if (trapped) break;
      }

      console.log('SERIAL:\n' + uart.text());
      console.log('Tier2 calls:', JSON.stringify(transport.calls.slice(-4)));
      console.log('Tier2 lastError:', transport.lastError);
      console.log('GPIO2 level:', gpio.level(2), 'expected:', EXPECT);
      expect(uart.text()).toContain('Blynk ready'); // setup completed (WiFi + Blynk.begin did not hang)
      expect(gpio.level(2)).toBe(EXPECT); // the dashboard V0 switch reached the LED
    }, 120000);
  },
);
