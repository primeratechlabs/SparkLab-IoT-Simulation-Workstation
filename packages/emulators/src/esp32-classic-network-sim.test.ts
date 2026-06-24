/**
 * STAGE 6 GATE #1 — WiFi + a sensor value sent/received over the (Tier-1 fake) Internet,
 * client-side, on the ESP32-classic (Xtensa). Identical sketch + runtime + network shim as the
 * C3 test; only the toolchain target (esp-clang Xtensa, call0) and the CPU (XtensaCpu) differ —
 * proving the network vertical works the SAME on both ESP32 families.
 *
 * Real arduino-esp32 `WiFi` for connectivity; Sparklab HTTP helper (SparkNet.h) for the value
 * round-trip; "Internet" is the Tier-1 fake server (no backend, I8); delay() is virtual-time
 * (I3). Skips when the (gitignored) wasm toolchain / classic WiFi SDK is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import {
  Tier1Network,
  Tier2Network,
  FakeHttpServer,
  FakeMqttBroker,
  type FetchFn,
} from '@sparklab/network-shim';
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
const PKG = join(ESPB, 'arduino-data', 'packages', 'esp32');
const X = join(PKG, 'tools', 'esp-x32', '2601');
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  existsSync(join(X, 'bin')) &&
  existsSync(join(sparkNetDir, 'SparkNet.h'));

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

function cflags(): string[] {
  return [
    ...target,
    ...headerEnv,
    '-Qunused-arguments',
    '-w',
    '-c',
    '-Os',
    '-fno-rtti',
    '-fno-exceptions',
    '-std=gnu++2a',
    '-DF_CPU=240000000L',
    '-DARDUINO=10607',
    '-DARDUINO_ESP32_DEV',
    '-DARDUINO_ARCH_ESP32',
    '-DESP32=ESP32',
    '-DARDUINO_USB_CDC_ON_BOOT=0',
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
  ];
}
function runtimeArgs(): string[] {
  return [
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
}
function sdkBundle(): ToolInput[] {
  const m = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  return m.map((rel) => ({
    path: join(ESPB, rel),
    bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
  }));
}
function elfLoad(elf: Uint8Array): { entry: number; segs: { addr: number; data: Uint8Array }[] } {
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const phoff = v.getUint32(28, true);
  const phes = v.getUint16(42, true);
  const phn = v.getUint16(44, true);
  const segs: { addr: number; data: Uint8Array }[] = [];
  for (let i = 0; i < phn; i++) {
    const p = phoff + i * phes;
    if (v.getUint32(p, true) !== 1) continue;
    const off = v.getUint32(p + 4, true);
    const vaddr = v.getUint32(p + 8, true);
    const filesz = v.getUint32(p + 16, true);
    if (filesz > 0) segs.push({ addr: vaddr, data: elf.slice(off, off + filesz) });
  }
  return { entry: v.getUint32(24, true), segs };
}

const SKETCH =
  '#include <Arduino.h>\n#include <WiFi.h>\n#include <SparkNet.h>\n' +
  'void setup(){\n' +
  '  Serial.begin(115200);\n' +
  '  pinMode(2, OUTPUT);\n' +
  '  WiFi.begin("sparklab", "secret");\n' +
  '  while (WiFi.status() != WL_CONNECTED) { delay(10); }\n' +
  '  Serial.println("WiFi up");\n' +
  '}\n' +
  'void loop(){\n' +
  '  int v = analogRead(34);\n' +
  '  Http.begin("iot.local", 80, "/telemetry");\n' +
  '  int code = Http.postValue(v);\n' +
  '  int relay = 0;\n' +
  '  while (Http.available()) { int c = Http.read(); if (c == 0x31) relay = 1; }\n' +
  '  digitalWrite(2, relay ? HIGH : LOW);\n' +
  '  if (code == 200) Serial.println("sent");\n' +
  '  delay(50);\n' +
  '}\n';

/** Compile sketch + runtime, link to a Xtensa firmware ELF (client-side). */
async function buildFirmware(tc: WasmRiscvToolchain, sketch: string): Promise<Uint8Array> {
  const sdk: ToolInput[] = [
    ...sdkBundle(),
    {
      path: join(sparkNetDir, 'SparkNet.h'),
      bytes: new Uint8Array(readFileSync(join(sparkNetDir, 'SparkNet.h'))),
    },
  ];
  const sk = await tc.compile({
    args: cflags(),
    sdk,
    sourcePath: '/sketch/net.cpp',
    sourceBytes: sketch,
  });
  if (sk.diagnostics.some((d) => d.severity === 'error'))
    throw new Error(JSON.stringify(sk.diagnostics));
  const rt = await tc.compile({
    args: runtimeArgs(),
    sdk: [],
    sourcePath: '/rt.cpp',
    sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
  });
  if (rt.diagnostics.some((d) => d.severity === 'error'))
    throw new Error(JSON.stringify(rt.diagnostics));
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
    throw new Error(JSON.stringify(lk.diagnostics));
  return lk.output;
}

/** Run firmware on the Xtensa emulator with an ASYNC-capable transport (yields for Tier-2 fetch). */
async function runXtensaAsync(
  fw: Uint8Array,
  transport: Tier1Network | Tier2Network,
  adcValue: number,
): Promise<{ gpio: C3Gpio; uart: C3Uart }> {
  const { entry, segs } = elfLoad(fw);
  const bus = new SimpleBus(new Uint8Array(0x40000));
  const gpio = new C3Gpio();
  const uart = new C3Uart();
  const adc = new C3Adc();
  adc.set(34, adcValue);
  const cpu = new XtensaCpu(bus);
  bus.map(C3_UART0_BASE, 0x80, uart);
  bus.map(C3_GPIO_BASE, 0x800, gpio);
  bus.map(C3_ADC_BASE, 0x100, adc);
  bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
  bus.map(C3_NET_BASE, 0x100, new C3Net(transport));
  for (const s of segs) bus.ram.set(s.data, s.addr);
  cpu.pc = entry;
  cpu.setReg(1, 0x30000);

  for (let batch = 0; batch < 3000 && !uart.text().includes('sent'); batch++) {
    let trapped = false;
    for (let k = 0; k < 100_000 && !uart.text().includes('sent'); k++) {
      try {
        cpu.step();
      } catch (e) {
        if (e instanceof XtensaTrap) {
          trapped = true;
          break;
        }
        throw e;
      }
    }
    if (trapped) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  return { gpio, uart };
}

describe.skipIf(!ready)(
  'Stage 6 — WiFi + sensor value over (Tier-1) internet, client-side (ESP32-classic / Xtensa)',
  () => {
    it('connects WiFi, POSTs the ADC reading, and drives the relay from the server reply', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      const sdk: ToolInput[] = [
        ...sdkBundle(),
        {
          path: join(sparkNetDir, 'SparkNet.h'),
          bytes: new Uint8Array(readFileSync(join(sparkNetDir, 'SparkNet.h'))),
        },
      ];
      const sk = await tc.compile({
        args: cflags(),
        sdk,
        sourcePath: '/sketch/net.cpp',
        sourceBytes: SKETCH,
      });
      expect(sk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(sk.object[18]! | (sk.object[19]! << 8)).toBe(94); // EM_XTENSA
      const rt = await tc.compile({
        args: runtimeArgs(),
        sdk: [],
        sourcePath: '/rt.cpp',
        sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
      });
      expect(rt.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const lk = await tc.link({
        args: ['-T', '/xtensa-flat.ld', '--gc-sections', '/sketch.o', '/rt.o'],
        inputs: [
          { path: '/xtensa-flat.ld', bytes: new Uint8Array(readFileSync(linkerScript)) },
          { path: '/sketch.o', bytes: sk.object },
          { path: '/rt.o', bytes: rt.object },
        ],
        outPath: '/fw.elf',
      });
      expect(lk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect([lk.output[0], lk.output[1], lk.output[2], lk.output[3]]).toEqual([
        0x7f, 0x45, 0x4c, 0x46,
      ]);

      // Tier-1 fake network: store the value, reply "1" (relay on) when above threshold
      let serverSawValue = -1;
      const server = new FakeHttpServer().route('iot.local', (req) => {
        serverSawValue = Number(req.body.replace('VAL=', ''));
        return { status: 200, body: serverSawValue > 2000 ? '1' : '0' };
      });
      const net = new Tier1Network({ connectPolls: 3, server });

      const { entry, segs } = elfLoad(lk.output);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const adc = new C3Adc();
      adc.set(34, 2750);
      const cpu = new XtensaCpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, adc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(net));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(1, 0x30000); // a1 = stack pointer

      for (let k = 0; k < 8_000_000 && !uart.text().includes('sent'); k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof XtensaTrap) break;
          throw e;
        }
      }

      expect(uart.text()).toContain('WiFi up');
      expect(server.requests.length).toBeGreaterThanOrEqual(1);
      expect(server.lastRequest()?.host).toBe('iot.local');
      expect(serverSawValue).toBe(2750);
      expect(gpio.level(2)).toBe(1);
      expect(uart.text()).toContain('sent');
    }, 180000);

    it('Tier 2 (mediated): the classic firmware POSTs through an injected fetch and acts on the reply', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const fw = await buildFirmware(tc, SKETCH);

      const calls: { url: string; body?: string }[] = [];
      const fetchFn: FetchFn = async (url, init) => {
        calls.push({ url, body: init?.body });
        return { status: 200, text: async () => '1' };
      };
      const { gpio, uart } = await runXtensaAsync(
        fw,
        new Tier2Network({ fetchFn, connectPolls: 3 }),
        2750,
      );

      expect(uart.text()).toContain('WiFi up');
      expect(calls[0]!.url).toBe('http://iot.local/telemetry');
      expect(calls[0]!.body).toBe('VAL=2750');
      expect(gpio.level(2)).toBe(1);
      expect(uart.text()).toContain('sent');
    }, 180000);

    it('MQTT (Tier 1 broker): classic firmware publishes telemetry and acts on a command', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const mqttSketch =
        '#include <Arduino.h>\n#include <WiFi.h>\n#include <SparkNet.h>\n' +
        'void setup(){ Serial.begin(115200); pinMode(2, OUTPUT); WiFi.begin("sparklab","secret");' +
        ' while(WiFi.status()!=WL_CONNECTED){delay(10);} Serial.println("WiFi up"); Mqtt.subscribe("dev/1/cmd"); }\n' +
        'void loop(){ int v=analogRead(34); Mqtt.publish("dev/1/telemetry", v); int relay=0;' +
        ' while(Mqtt.available()){ int c; while((c=Mqtt.read())!=0){ if(c==0x31) relay=1; } Mqtt.next(); }' +
        ' digitalWrite(2, relay?HIGH:LOW); Serial.println("pub"); delay(50); }\n';
      const fw = await buildFirmware(tc, mqttSketch);

      const broker = new FakeMqttBroker();
      const { entry, segs } = elfLoad(fw);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const adc = new C3Adc();
      adc.set(34, 2750);
      const cpu = new XtensaCpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, adc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(new Tier1Network({ connectPolls: 3 }), broker));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(1, 0x30000);

      let injected = false;
      for (let k = 0; k < 8_000_000 && gpio.level(2) !== 1; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof XtensaTrap) break;
          throw e;
        }
        if (!injected && broker.published.length > 0) {
          broker.inject('dev/1/cmd', '1');
          injected = true;
        }
      }

      expect(uart.text()).toContain('WiFi up');
      expect(broker.last('dev/1/telemetry')?.payload).toBe('2750');
      expect(gpio.level(2)).toBe(1);
    }, 180000);
  },
);
