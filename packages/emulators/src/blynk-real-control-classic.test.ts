/**
 * Credential-gated reproduction of the user's EXACT sketch on the ESP32-classic (Xtensa) path:
 * BlynkSimpleWifi.h + Blynk.begin(token, ssid, pass) + BLYNK_CONNECTED{syncVirtual(V0)} +
 * loop(){ if(Blynk.connected()) Blynk.run(); }. Drives GPIO2 (the classic on-board LED) from a real
 * dashboard V0 switch over the REAL Tier-2 fetch to blynk.cloud, on the XtensaCpu.
 *
 * Skips unless BLYNK_TOKEN is set:  BLYNK_TOKEN=xxxx BLYNK_V0=1 pnpm vitest run packages/emulators/src/blynk-real-control-classic.test.ts
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { Tier2Network } from '@sparklab/network-shim';
import { XtensaCpu, SimpleBus, XtensaTrap } from './xtensa.js';
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
const ESPB = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const WASM_OUT = join(REPO, 'ci', 'toolchain-builder', 'esp32-classic', 'build', 'wasm-out');
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const manifestPath = join(
  here,
  '..',
  '..',
  'toolchain-loader',
  'src',
  '__fixtures__',
  'esp32-classic-wifi-sdk-manifest.txt',
);
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const linkerScript = join(here, 'sim-runtime', 'xtensa-flat.ld');
const sparkNetDir = join(here, '__fixtures__', 'SparkNet');
const sparkBlynkDir = join(here, '__fixtures__', 'SparkBlynk');
const PKG = join(ESPB, 'arduino-data', 'packages', 'esp32');
const X = join(PKG, 'tools', 'esp-x32', '2601');
const TOKEN = process.env.BLYNK_TOKEN;
const ready =
  !!TOKEN &&
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  existsSync(join(X, 'bin')) &&
  existsSync(join(sparkBlynkDir, 'BlynkSimpleWifi.h'));

const CL = join(PKG, 'tools', 'esp32-libs', '3.3.10');
const CORE = join(PKG, 'hardware', 'esp32', '3.3.10');
const CXX = `${X}/xtensa-esp-elf/include/c++/14.2.0`;
const LIBS = join(CORE, 'libraries');
const target = [
  '--target=xtensa-esp-elf',
  '-mcpu=esp32',
  '-Xclang',
  '-target-feature',
  '-Xclang',
  '-windowed',
];
const headerEnv = [
  `--gcc-toolchain=${X}`,
  `--sysroot=${X}/xtensa-esp-elf`,
  '-stdlib=libstdc++',
  '-nobuiltininc',
  '-isystem',
  `${X}/lib/gcc/xtensa-esp-elf/14.2.0/include`,
  '-isystem',
  CXX,
  '-isystem',
  `${CXX}/xtensa-esp-elf/esp32`,
  '-isystem',
  `${CXX}/backward`,
  '-isystem',
  `${X}/xtensa-esp-elf/include`,
];
const cflags = (): string[] => [
  // Mirror the production esp32ClassicSketchArgs (incl. -ffunction-sections/-fdata-sections) so this
  // exercises the real flags — and proves --gc-sections does NOT drop the retained BLYNK_WRITE handler.
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
  '-DF_CPU=240000000L',
  '-DARDUINO=10607',
  '-DARDUINO_ESP32_DEV',
  '-DARDUINO_ARCH_ESP32',
  '-DESP32=ESP32',
  '-DARDUINO_USB_CDC_ON_BOOT=0',
  '-DCORE_DEBUG_LEVEL=0',
  `@${CL}/flags/defines`,
  '-iprefix',
  `${CL}/include/`,
  `@${CL}/flags/includes`,
  `-I${CL}/qio_qspi/include`,
  `-I${CORE}/cores/esp32`,
  `-I${CORE}/variants/esp32`,
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
  const sdk = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((rel) => ({
      path: join(ESPB, rel),
      bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
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

// The user's EXACT sketch (token injected from env).
const userSketch = (token: string): string =>
  '#define BLYNK_TEMPLATE_ID "TMPL6F3LbyRVw"\n#define BLYNK_TEMPLATE_NAME "SE08301 ESP32"\n' +
  `#define BLYNK_AUTH_TOKEN "${token}"\n#define BLYNK_PRINT Serial\n` +
  '#include <WiFi.h>\n#include <BlynkSimpleWifi.h>\n' +
  'char ssid[] = "Sparklab-GUEST";\nchar pass[] = "";\n' +
  'const int LED_PIN = 2;\n' +
  'BLYNK_WRITE(V0) { int value = param.asInt(); digitalWrite(LED_PIN, value); Serial.print("LED: "); Serial.println(value ? "ON" : "OFF"); }\n' +
  'BLYNK_CONNECTED() { Blynk.syncVirtual(V0); }\n' +
  'void setup() {\n  Serial.begin(115200);\n  delay(100);\n  pinMode(LED_PIN, OUTPUT);\n  digitalWrite(LED_PIN, LOW);\n' +
  '  Serial.println("\\n\\n=== Blynk IoT LED Control ===");\n  Blynk.begin(BLYNK_AUTH_TOKEN, ssid, pass);\n}\n' +
  'void loop() {\n  if (Blynk.connected()) {\n    Blynk.run();\n  }\n  delay(100);\n}\n';

describe.skipIf(!ready)(
  'Blynk dashboard→device — user sketch on ESP32-classic (Xtensa), REAL cloud',
  () => {
    it('drives GPIO2 (classic on-board LED) from the dashboard V0 switch', async () => {
      // Read the live V0 the dashboard switch is set to RIGHT NOW, so the assertion is self-checking
      // regardless of which way the user last flipped it.
      const v0resp = await fetch(`https://blynk.cloud/external/api/get?token=${TOKEN}&V0`).then(
        (r) => r.text(),
      );
      const EXPECT = /1/.test(v0resp) ? 1 : 0;
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const sdk = sdkBundle();
      const sk = await tc.compile({
        args: cflags(),
        sdk,
        sourcePath: '/sketch/app.cpp',
        sourceBytes: userSketch(TOKEN!),
      });
      if (sk.diagnostics.some((d) => d.severity === 'error'))
        throw new Error('sketch: ' + JSON.stringify(sk.diagnostics));
      const rt = await tc.compile({
        args: runtimeArgs(),
        sdk: [],
        sourcePath: '/rt.cpp',
        sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
      });
      if (rt.diagnostics.some((d) => d.severity === 'error'))
        throw new Error('runtime: ' + JSON.stringify(rt.diagnostics));
      const lk = await tc.link({
        args: ['-T', '/xtensa-flat.ld', '--gc-sections', '/sketch.o', '/rt.o'],
        inputs: [
          { path: '/xtensa-flat.ld', bytes: new Uint8Array(readFileSync(linkerScript)) },
          { path: '/sketch.o', bytes: sk.object },
          { path: '/rt.o', bytes: rt.object },
        ],
        outPath: '/fw.elf',
      });
      if (lk.diagnostics.some((d) => d.severity === 'error'))
        throw new Error('link: ' + JSON.stringify(lk.diagnostics));

      const transport = new Tier2Network({}); // real global fetch → blynk.cloud
      const { entry, segs } = elfLoad(lk.output);
      const bus = new SimpleBus(new Uint8Array(0x100000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const cpu = new XtensaCpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, new C3Adc());
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(transport));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(1, 0xf0000);

      let matched = false;
      let trapMsg = '';
      for (let batch = 0; batch < 400 && !matched; batch++) {
        let trapped = false;
        for (let k = 0; k < 200_000; k++) {
          try {
            cpu.step();
          } catch (e) {
            if (e instanceof XtensaTrap) {
              trapped = true;
              trapMsg = (e as Error).message;
              break;
            }
            throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 5));
        if (gpio.level(2) === EXPECT) matched = true;
        if (trapped) break;
      }

      console.log('SERIAL:\n' + uart.text());
      console.log('Tier2 calls:', JSON.stringify(transport.calls.slice(-4)));
      console.log('Tier2 lastError:', transport.lastError, '| trap:', trapMsg || '(none)');
      console.log('GPIO2 level:', gpio.level(2), 'expected:', EXPECT);
      expect(trapMsg).toBe(''); // no unimplemented Xtensa opcode tripped the Blynk path
      expect(gpio.level(2)).toBe(EXPECT);
    }, 120000);
  },
);
