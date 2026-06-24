/**
 * STAGE 6 GATE #1 — WiFi + a sensor value sent/received over the (Tier-1 fake) Internet,
 * client-side, on the ESP32-C3 (rv32). The full vertical:
 *   real sketch (WiFi.begin + analogRead + Http.postValue)  --wasm clang-->  object
 *   sim runtime (WiFi/HTTP/ADC HAL + crt0)                  --wasm clang-->  object
 *   both                                                    --wasm lld---->  firmware ELF
 *   firmware  --Rv32Cpu + C3Net(@sparklab/network-shim)-->  WiFi connects, value round-trips
 *
 * The sketch uses the REAL arduino-esp32 `WiFi` (begin/status → WL_CONNECTED) for connectivity;
 * the Sparklab HTTP helper (SparkNet.h) sends the ADC reading and reads a command back. The
 * "Internet" is the Tier-1 fake server (no backend, I8); delay() is virtual-time (I3). Skips when
 * the (gitignored) wasm toolchain / WiFi SDK is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import {
  Tier1Network,
  Tier2Network,
  Tier2Mqtt,
  FakeHttpServer,
  FakeMqttBroker,
  FakeBlynkServer,
  FakeBlynkPresence,
  type FetchFn,
  type WebSocketLike,
} from '@sparklab/network-shim';
import { Rv32Cpu, SimpleBus, Rv32Trap } from './rv32.js';
import { Rv32Runner } from './rv32-runner.js';
import { buildC3Firmware } from '@sparklab/build-orchestrator';
import {
  C3Gpio,
  C3Uart,
  C3Adc,
  C3Ledc,
  C3SysTimer,
  C3_GPIO_BASE,
  C3_UART0_BASE,
  C3_ADC_BASE,
  C3_LEDC_BASE,
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
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(wifiManifestPath) &&
  existsSync(join(PKG, 'tools', 'esp-rv32', '2601')) &&
  existsSync(join(sparkNetDir, 'SparkNet.h'));

const GCC = join(PKG, 'tools', 'esp-rv32', '2601');
const C3 = join(PKG, 'tools', 'esp32c3-libs', '3.3.10');
const CORE = join(PKG, 'hardware', 'esp32', '3.3.10');
const CXX = `${GCC}/riscv32-esp-elf/include/c++/14.2.0`;
const LIBS = join(CORE, 'libraries');

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

function sketchArgs(): string[] {
  return [
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
  const entries = readFileSync(wifiManifestPath, 'utf8').split('\n').filter(Boolean);
  return entries.map((rel) => ({
    path: join(BUILD, rel),
    bytes: new Uint8Array(readFileSync(join(BUILD, rel))),
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

// The sketch: connect WiFi, read a sensor (ADC), POST the value, act on the command in the reply.
// Parameterised by the endpoint so the same firmware logic can target the fake server (Tier 1),
// a mock fetch, or a real host (Tier 2). 0x31 == '1' (the relay-on command byte).
const makeSketch = (host: string, port: number, path: string): string =>
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
  `  Http.begin("${host}", ${port}, "${path}");\n` +
  '  int code = Http.postValue(v);\n' +
  '  int relay = 0;\n' +
  '  while (Http.available()) { int c = Http.read(); if (c == 0x31) relay = 1; }\n' +
  '  digitalWrite(2, relay ? HIGH : LOW);\n' +
  '  if (code == 200) Serial.println("sent");\n' +
  '  delay(50);\n' +
  '}\n';
const SKETCH = makeSketch('iot.local', 80, '/telemetry');

// MQTT variant: subscribe to a command topic, publish telemetry, act on a received command.
const MQTT_SKETCH =
  '#include <Arduino.h>\n#include <WiFi.h>\n#include <SparkNet.h>\n' +
  'void setup(){\n' +
  '  Serial.begin(115200);\n  pinMode(2, OUTPUT);\n' +
  '  WiFi.begin("sparklab", "secret");\n  while (WiFi.status() != WL_CONNECTED) { delay(10); }\n' +
  '  Serial.println("WiFi up");\n  Mqtt.subscribe("dev/1/cmd");\n}\n' +
  'void loop(){\n' +
  '  int v = analogRead(34);\n  Mqtt.publish("dev/1/telemetry", v);\n  int relay = 0;\n' +
  '  while (Mqtt.available()) { int c; while ((c = Mqtt.read()) != 0) { if (c == 0x31) relay = 1; } Mqtt.next(); }\n' +
  '  digitalWrite(2, relay ? HIGH : LOW);\n  Serial.println("pub");\n  delay(50);\n}\n';

/** Compile a sketch + the sim runtime and link to a firmware ELF (client-side). */
async function buildFirmware(tc: WasmRiscvToolchain, sketch: string): Promise<Uint8Array> {
  const sdk: ToolInput[] = [
    ...sdkBundle(),
    {
      path: join(sparkNetDir, 'SparkNet.h'),
      bytes: new Uint8Array(readFileSync(join(sparkNetDir, 'SparkNet.h'))),
    },
    // SparkBlynk.h + the Blynk-compat shims (BlynkSimpleWifi.h, …) so `#include <BlynkSimpleWifi.h>` resolves.
    ...readdirSync(sparkBlynkDir)
      .filter((f) => f.endsWith('.h'))
      .map((f) => ({
        path: join(sparkBlynkDir, f),
        bytes: new Uint8Array(readFileSync(join(sparkBlynkDir, f))),
      })),
  ];
  const sk = await tc.compile({
    args: sketchArgs(),
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
    args: ['-Ttext=0', '-e', '_start', '--gc-sections', '/sketch.o', '/rt.o'],
    inputs: [
      { path: '/sketch.o', bytes: sk.object },
      { path: '/rt.o', bytes: rt.object },
    ],
    outPath: '/fw.elf',
  });
  if (lk.diagnostics.some((d) => d.severity === 'error'))
    throw new Error(JSON.stringify(lk.diagnostics));
  return lk.output;
}

/** Run firmware on the rv32 emulator with an ASYNC-capable network transport. The run loop yields
 *  between batches so a pending (Tier-2) fetch can resolve while the firmware spins on HTTP_READY. */
async function runC3Async(
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
  const cpu = new Rv32Cpu(bus);
  bus.map(C3_UART0_BASE, 0x80, uart);
  bus.map(C3_GPIO_BASE, 0x800, gpio);
  bus.map(C3_ADC_BASE, 0x100, adc);
  bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
  bus.map(C3_NET_BASE, 0x100, new C3Net(transport));
  for (const s of segs) bus.ram.set(s.data, s.addr);
  cpu.pc = entry;
  cpu.setReg(2, 0x30000);

  for (let batch = 0; batch < 3000 && !uart.text().includes('sent'); batch++) {
    let trapped = false;
    for (let k = 0; k < 100_000 && !uart.text().includes('sent'); k++) {
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
    if (trapped) break;
    await new Promise((r) => setTimeout(r, 2)); // let a pending fetch resolve
  }
  return { gpio, uart };
}

describe.skipIf(!ready)(
  'Stage 6 — WiFi + sensor value over (Tier-1) internet, client-side (C3 / rv32)',
  () => {
    it('connects WiFi, POSTs the ADC reading, and drives the relay from the server reply', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      // 1) compile the real WiFi sketch + the sim runtime, link to firmware (all client-side).
      //    SparkNet.h is mounted into the wasm FS at its host path so the `-I` resolves it.
      const sdk: ToolInput[] = [
        ...sdkBundle(),
        {
          path: join(sparkNetDir, 'SparkNet.h'),
          bytes: new Uint8Array(readFileSync(join(sparkNetDir, 'SparkNet.h'))),
        },
      ];
      const sk = await tc.compile({
        args: sketchArgs(),
        sdk,
        sourcePath: '/sketch/net.cpp',
        sourceBytes: SKETCH,
      });
      expect(sk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(sk.object[18]! | (sk.object[19]! << 8)).toBe(243); // EM_RISCV
      const rt = await tc.compile({
        args: runtimeArgs(),
        sdk: [],
        sourcePath: '/rt.cpp',
        sourceBytes: new Uint8Array(readFileSync(runtimeCpp)),
      });
      expect(rt.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const lk = await tc.link({
        args: ['-Ttext=0', '-e', '_start', '--gc-sections', '/sketch.o', '/rt.o'],
        inputs: [
          { path: '/sketch.o', bytes: sk.object },
          { path: '/rt.o', bytes: rt.object },
        ],
        outPath: '/fw.elf',
      });
      expect(lk.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect([lk.output[0], lk.output[1], lk.output[2], lk.output[3]]).toEqual([
        0x7f, 0x45, 0x4c, 0x46,
      ]);

      // 2) Tier-1 fake network: store the reported value, reply "1" (relay on) when value > 2000
      let serverSawValue = -1;
      const server = new FakeHttpServer().route('iot.local', (req) => {
        serverSawValue = Number(req.body.replace('VAL=', ''));
        return { status: 200, body: serverSawValue > 2000 ? '1' : '0' };
      });
      const net = new Tier1Network({ connectPolls: 3, server });

      // 3) run the firmware with the C3 peripherals + the network MMIO
      const { entry, segs } = elfLoad(lk.output);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const adc = new C3Adc();
      adc.set(34, 2750); // a sensor reading above the relay threshold
      const cpu = new Rv32Cpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, adc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(net));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(2, 0x30000);

      // run until a full request→reply→act→ack cycle completes ("sent" prints after digitalWrite)
      for (let k = 0; k < 8_000_000 && !uart.text().includes('sent'); k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof Rv32Trap) break;
          throw e;
        }
      }

      // WiFi reached connected (the spin terminated and Serial printed)
      expect(uart.text()).toContain('WiFi up');
      // the sensor value travelled to the server over the (fake) Internet
      expect(server.requests.length).toBeGreaterThanOrEqual(1);
      expect(server.lastRequest()?.host).toBe('iot.local');
      expect(server.lastRequest()?.path).toBe('/telemetry');
      expect(serverSawValue).toBe(2750);
      // the firmware received the command in the reply and acted on it (relay/LED on)
      expect(gpio.level(2)).toBe(1);
      expect(uart.text()).toContain('sent'); // HTTP status 200 round-tripped
    }, 180000);

    it('production Rv32Runner({ transport }) wires C3Net itself — the workspace seam, no manual bus.map', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const fw = await buildFirmware(tc, SKETCH);

      let sawValue = -1;
      const server = new FakeHttpServer().route('iot.local', (req) => {
        sawValue = Number(req.body.replace('VAL=', ''));
        return { status: 200, body: sawValue > 2000 ? '1' : '0' };
      });
      // The same construction the sim worker uses: pass the transport in, the runner maps C3Net at
      // C3_NET_BASE. Tier 1 is synchronous, so the runner's own executeForMillis loop suffices.
      const runner = new Rv32Runner(fw, {
        transport: new Tier1Network({ connectPolls: 3, server }),
      });
      expect(runner.net).not.toBeNull();
      runner.setAdc(34, 2750);
      for (let i = 0; i < 400 && !runner.serial().includes('sent'); i++)
        runner.executeForMillis(20);

      expect(runner.serial()).toContain('WiFi up');
      expect(sawValue).toBe(2750); // sensor value reached the fake server through the mapped MMIO
      expect(runner.pins[2]).toBe(1); // the reply drove the relay — full roundtrip via the production ctor
    }, 180000);

    it('WORKSPACE build path: c3SketchArgs resolves <WiFi.h> + <SparkBlynk.h> from the pack (no explicit -I)', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // Mount the SDK as the browser worker does: pack files at their paths + the spark headers at
      // <root>/spark. Build with the PRODUCTION buildC3Firmware (c3SketchArgs) — NOT the test's own -I
      // list — so this proves a workspace ESP32 sketch using WiFi.h + Blynk actually compiles + links.
      const sdk = [
        ...sdkBundle(),
        {
          path: join(BUILD, 'spark', 'SparkNet.h'),
          bytes: new Uint8Array(readFileSync(join(sparkNetDir, 'SparkNet.h'))),
        },
        {
          path: join(BUILD, 'spark', 'SparkBlynk.h'),
          bytes: new Uint8Array(readFileSync(join(sparkBlynkDir, 'SparkBlynk.h'))),
        },
      ];
      const sketch =
        '#include <Arduino.h>\n#include <WiFi.h>\n#include <SparkBlynk.h>\n' +
        'BLYNK_WRITE(V0){ digitalWrite(2, param.asInt() ? HIGH : LOW); }\n' +
        'void setup(){ Serial.begin(115200); pinMode(2, OUTPUT); WiFi.begin("Sparklab-GUEST", ""); Blynk.begin("TOK"); }\n' +
        'void loop(){ Blynk.run(); Blynk.virtualWrite(V1, analogRead(34)); delay(1000); }\n';
      const built = await buildC3Firmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
        sdk,
        root: BUILD,
      });
      expect(built.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(built.ok).toBe(true);
      expect([built.elf![0], built.elf![1], built.elf![2], built.elf![3]]).toEqual([
        0x7f, 0x45, 0x4c, 0x46,
      ]);
    }, 180000);

    it('a real ESP32 WiFi sketch links + runs: WiFi.mode + WiFi.localIP + Serial.println(IPAddress)', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // The user's exact sketch — uses WiFi.mode(WIFI_STA) + WiFi.localIP() + Serial.println(IPAddress),
      // which previously failed at link ("undefined symbol: WiFiGenericClass::mode(wifi_mode_t)").
      const sketch =
        '#include <WiFi.h>\n' +
        'const char* ssid = "Sparklab-GUEST";\nconst char* password = "";\n' +
        'void setup(){\n' +
        '  Serial.begin(115200);\n  delay(1000);\n' +
        '  Serial.println("Starting WiFi connection...");\n' +
        '  WiFi.mode(WIFI_STA);\n  WiFi.begin(ssid, password);\n' +
        '  int attempts = 0;\n' +
        '  while (WiFi.status() != WL_CONNECTED && attempts < 20) { delay(500); Serial.print("."); attempts++; }\n' +
        '  if (WiFi.status() == WL_CONNECTED) {\n' +
        '    Serial.println("WiFi connected!");\n' +
        '    Serial.print("IP address: ");\n    Serial.println(WiFi.localIP());\n' +
        '  } else { Serial.println("Failed to connect to WiFi"); }\n' +
        '}\n' +
        'void loop(){ delay(10000); }\n';
      const fw = await buildFirmware(tc, sketch); // throws if any symbol is undefined at link
      const runner = new Rv32Runner(fw, { transport: new Tier1Network({ connectPolls: 3 }) });
      for (let i = 0; i < 300 && !runner.serial().includes('IP address'); i++)
        runner.executeForMillis(20);

      expect(runner.serial()).toContain('WiFi connected!');
      expect(runner.serial()).toContain('IP address: 192.168.4.2'); // localIP() printed via the IPAddress vtable
    }, 180000);

    it('firmware-driven Blynk: real-library idioms (virtualWrite + BLYNK_WRITE) over HTTP, client-side', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // A sketch that reads like a real Blynk sketch: WiFi.h to join the virtual AP, then Blynk idioms.
      const sketch =
        '#include <Arduino.h>\n#include <WiFi.h>\n#include <SparkBlynk.h>\n' +
        'BLYNK_WRITE(V0){ digitalWrite(2, param.asInt() ? HIGH : LOW); }\n' + // dashboard → relay
        'void setup(){\n  Serial.begin(115200);\n  pinMode(2, OUTPUT);\n' +
        '  WiFi.begin("Sparklab-GUEST", "");\n  while (WiFi.status() != WL_CONNECTED) { delay(10); }\n' +
        '  Blynk.begin("TESTTOKEN");\n  Serial.println("blynk up");\n}\n' +
        'void loop(){\n  Blynk.run();\n  int v = analogRead(34);\n  Blynk.virtualWrite(V1, v);\n  delay(1000);\n}\n';
      const fw = await buildFirmware(tc, sketch);

      const blynk = new FakeBlynkServer();
      blynk.inject(0, '1'); // the Blynk app set V0=1 (relay ON) before the device polls
      const server = new FakeHttpServer().route('blynk.cloud', blynk.handler());
      const presence = new FakeBlynkPresence();
      const runner = new Rv32Runner(fw, {
        transport: new Tier1Network({ connectPolls: 3, server }),
        blynk: presence,
      });
      runner.setAdc(34, 1234);
      for (let i = 0; i < 1500 && (runner.pins[2] !== 1 || blynk.vpins.get(1) !== '1234'); i++) {
        runner.executeForMillis(20);
      }

      expect(runner.serial()).toContain('blynk up');
      expect(presence.token).toBe('TESTTOKEN'); // Blynk.begin opened the MQTT device session (→ "online")
      expect(blynk.vpins.get(1)).toBe('1234'); // device → cloud: analogRead(34) reached V1 via /update
      expect(runner.pins[2]).toBe(1); // cloud → device: the dashboard V0=1 drove the relay via BLYNK_WRITE
    }, 180000);

    it('a standard Blynk sketch (#include <BlynkSimpleWifi.h> + BLYNK_TEMPLATE macros) runs via the HTTP shim', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // The user's sketch shape: the real Blynk include + template macros. The compat header maps it to the
      // simulator's HTTP Blynk (no real Blynk library → no "duplicate symbol: Blynk").
      const sketch =
        '#define BLYNK_TEMPLATE_ID "TMPL6F3LbyRVw"\n#define BLYNK_TEMPLATE_NAME "SE08301 ESP32"\n' +
        '#define BLYNK_AUTH_TOKEN "tok123"\n#define BLYNK_PRINT Serial\n' +
        '#include <WiFi.h>\n#include <BlynkSimpleWifi.h>\nconst int LED_PIN = 2;\nint fakeSensor = 0;\n' +
        'BLYNK_WRITE(V0){ int value = param.asInt(); digitalWrite(LED_PIN, value); Serial.print("LED PIN 2 "); Serial.println(value); }\n' +
        'void setup(){ Serial.begin(115200); pinMode(LED_PIN, OUTPUT); Blynk.begin(BLYNK_AUTH_TOKEN, "Sparklab-GUEST", ""); }\n' +
        'void loop(){ if (Blynk.connected()){ Serial.println("Wifi connected!"); Blynk.run(); } else { Serial.println("Failed!"); }\n' +
        '  fakeSensor += 2; Blynk.virtualWrite(V1, fakeSensor); delay(2000); }\n';
      const fw = await buildFirmware(tc, sketch); // throws if link fails (duplicate/undefined symbol)

      const blynk = new FakeBlynkServer();
      blynk.inject(0, '1'); // the Blynk app set V0=1 (LED on)
      const server = new FakeHttpServer().route('blynk.cloud', blynk.handler());
      const presence = new FakeBlynkPresence();
      const runner = new Rv32Runner(fw, {
        transport: new Tier1Network({ connectPolls: 3, server }),
        blynk: presence,
      });
      for (let i = 0; i < 1500 && !blynk.vpins.has(1); i++) runner.executeForMillis(20); // run a full loop pass

      expect(presence.token).toBe('tok123'); // Blynk.begin opened the MQTT device session (the "online" link)
      // The stock Blynk startup banner, reproduced faithfully (ASCII logo + "v<ver> on <board>").
      expect(runner.serial()).toMatch(/\/___\/ v\d+\.\d+\.\d+ on ESP32/);
      // The full WiFi-connect block the 3-arg Blynk.begin prints (was missing) + the cloud handshake.
      expect(runner.serial()).toContain('Connecting to Sparklab-GUEST'); // connectWiFi log (the SSID from the sketch)
      expect(runner.serial()).toContain('Connected to WiFi');
      expect(runner.serial()).toContain('IP: 192.168.4.2');
      expect(runner.serial()).toContain('Connecting to blynk.cloud:443'); // real Blynk handshake log (with :443)
      expect(runner.serial()).toMatch(/Ready \(ping: \d+ms\)\./); // device session established (trailing dot, like the lib)
      expect(runner.serial()).not.toContain('Connection failed, will retry'); // removed the fabricated line
      expect(runner.serial()).toContain('Wifi connected!'); // Blynk.connected() now reflects the device session
      expect(runner.serial()).toContain('LED PIN 2 1'); // BLYNK_WRITE(V0) fired + Serial.println(int) works
      expect(runner.pins[2]).toBe(1); // dashboard V0=1 drove the LED via the compat shim
      expect(Number(blynk.vpins.get(1))).toBeGreaterThan(0); // virtualWrite(V1, fakeSensor) reached the cloud
    }, 180000);

    it('firmware-driven Blynk over Tier-2 (the REAL fetch path): BLYNK_WRITE fires even when the device is NOT "online"', async () => {
      // The path a real 'Internet'-tier run takes: firmware virtualWrite/run → C3Net HTTP → Tier2Network.fetch
      // → blynk.cloud (injected fetch, no egress). Crucially the sketch GATES run() on Blynk.connected() and NO
      // MQTT presence is wired (NET_BLYNK_STATUS=0, device shows offline) — exactly the user's case where
      // dashboard→device (BLYNK_WRITE / LED) stopped working. connected() must reflect the DATA path (WiFi up),
      // not the presence, or run() never polls. /get returns a BARE value (the real Blynk format), not ["1"].
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const sketch =
        '#define BLYNK_AUTH_TOKEN "REALTOKEN"\n#define BLYNK_PRINT Serial\n' +
        '#include <WiFi.h>\n#include <BlynkSimpleWifi.h>\nint sensor = 41;\n' +
        'BLYNK_WRITE(V0){ digitalWrite(2, param.asInt()); }\n' +
        'void setup(){ Serial.begin(115200); pinMode(2, OUTPUT); Blynk.begin(BLYNK_AUTH_TOKEN, "Sparklab-GUEST", ""); }\n' +
        'void loop(){ if (Blynk.connected()){ Blynk.run(); } sensor += 1; Blynk.virtualWrite(V1, sensor); delay(1000); }\n';
      const fw = await buildFirmware(tc, sketch);

      const calls: string[] = [];
      const fetchFn: FetchFn = async (url) => {
        calls.push(url);
        if (url.includes('/external/api/get') && /[?&]V0\b/.test(url))
          return { status: 200, text: async () => '1' }; // app set V0=1 (BARE — real format)
        return { status: 200, text: async () => '1' }; // /update → 200
      };
      const net = new Tier2Network({ fetchFn, connectPolls: 3 });
      const runner = new Rv32Runner(fw, { transport: net }); // NO presence wired → device "offline" — run() must still fire
      for (let i = 0; i < 1500 && runner.pins[2] !== 1; i++) {
        runner.executeForMillis(20);
        await new Promise((r) => setTimeout(r, 0)); // let the injected fetch resolve between ticks
      }

      // device → cloud: virtualWrite(V1, sensor) hit the REAL Blynk Device API URL (token + Vn in the query)
      expect(
        calls.some((u) =>
          /^https:\/\/blynk\.cloud\/external\/api\/update\?token=REALTOKEN&V1=\d+$/.test(u),
        ),
      ).toBe(true);
      // cloud → device: run() polled /get?..&V0 and the bare "1" reply drove BLYNK_WRITE(V0) → LED on, even
      // though the device is not "online" (presence offline) — the regression for the connected() gating bug.
      expect(
        calls.some((u) =>
          /^https:\/\/blynk\.cloud\/external\/api\/get\?token=REALTOKEN&V0$/.test(u),
        ),
      ).toBe(true);
      expect(runner.pins[2]).toBe(1);
    }, 180000);

    it('Tier 2 (mediated): the POST is carried by an injected fetch; the reply drives the relay', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const fw = await buildFirmware(tc, SKETCH);

      const calls: { url: string; method?: string; body?: string }[] = [];
      const fetchFn: FetchFn = async (url, init) => {
        calls.push({ url, method: init?.method, body: init?.body });
        return { status: 200, text: async () => '1' }; // server replies "relay on"
      };
      const net = new Tier2Network({ fetchFn, connectPolls: 3 });
      const { gpio, uart } = await runC3Async(fw, net, 2750);

      expect(uart.text()).toContain('WiFi up');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]!.url).toBe('http://iot.local/telemetry'); // the firmware's host:port/path → a real URL
      expect(calls[0]!.method).toBe('POST');
      expect(calls[0]!.body).toBe('VAL=2750'); // the sensor value left the device through fetch
      expect(gpio.level(2)).toBe(1); // the "1" reply came back and drove the relay
      expect(uart.text()).toContain('sent');
    }, 180000);

    it('Tier 2 reaches the REAL Internet via fetch (postman-echo / https) — skipped if offline', async (ctx) => {
      // preflight: only run when the public echo endpoint is actually reachable from here
      let online = false;
      try {
        const probe = await fetch('https://postman-echo.com/post', {
          method: 'POST',
          body: 'ping',
        });
        online = probe.status === 200;
      } catch {
        online = false;
      }
      if (!online) return ctx.skip();

      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const fw = await buildFirmware(tc, makeSketch('postman-echo.com', 443, '/post'));

      // a real fetch transport that also captures the response body for assertion
      const responses: string[] = [];
      const fetchFn: FetchFn = async (url, init) => {
        const r = await fetch(url, { method: init?.method, body: init?.body });
        const text = await r.text();
        responses.push(text);
        return { status: r.status, text: async () => text };
      };
      const net = new Tier2Network({ fetchFn, connectPolls: 3 });
      const { uart } = await runC3Async(fw, net, 2750);

      expect(uart.text()).toContain('WiFi up');
      expect(uart.text()).toContain('sent'); // the REAL server returned HTTP 200
      expect(net.calls[0]!.url).toBe('https://postman-echo.com/post');
      expect(responses.length).toBeGreaterThanOrEqual(1);
      expect(responses[0]).toContain('VAL=2750'); // our value went out AND echoed back over the real Internet
    }, 180000);

    it('MQTT (Tier 1 broker): publishes telemetry and acts on a subscribed command', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const fw = await buildFirmware(tc, MQTT_SKETCH);

      const broker = new FakeMqttBroker();
      const { entry, segs } = elfLoad(fw);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const adc = new C3Adc();
      adc.set(34, 2750);
      const cpu = new Rv32Cpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, adc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(new Tier1Network({ connectPolls: 3 }), broker));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(2, 0x30000);

      let injected = false;
      for (let k = 0; k < 8_000_000 && gpio.level(2) !== 1; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof Rv32Trap) break;
          throw e;
        }
        // once the device has published its first telemetry, the "cloud" sends a relay-on command
        if (!injected && broker.published.length > 0) {
          broker.inject('dev/1/cmd', '1');
          injected = true;
        }
      }

      expect(uart.text()).toContain('WiFi up');
      expect(broker.last('dev/1/telemetry')?.payload).toBe('2750'); // sensor value published to the topic
      expect(gpio.level(2)).toBe(1); // the subscribed command was received and acted on
    }, 180000);

    it('MQTT over WebSocket (Tier 2 transport): firmware pub/sub through a real MQTT client', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const fw = await buildFirmware(tc, MQTT_SKETCH);

      // a minimal in-memory broker over the WebSocket wire: CONNACK / SUBACK, and echo each
      // PUBLISH back so Tier2Mqtt routes it to whoever subscribed to that topic.
      class LoopWs implements WebSocketLike {
        readyState = 1;
        binaryType = 'arraybuffer';
        onopen: ((ev?: unknown) => void) | null = null;
        onmessage: ((ev: { data: unknown }) => void) | null = null;
        onclose: ((ev?: unknown) => void) | null = null;
        onerror: ((ev?: unknown) => void) | null = null;
        constructor() {
          queueMicrotask(() => this.onopen?.());
        }
        send(d: Uint8Array): void {
          const t = d[0]! >> 4;
          if (t === 1)
            this.reply([0x20, 0x02, 0, 0]); // CONNACK
          else if (t === 8)
            this.reply([0x90, 0x03, d[2] ?? 0, d[3] ?? 0, 0]); // SUBACK
          else if (t === 3) this.reply(Array.from(d)); // echo PUBLISH back as inbound
        }
        close(): void {
          this.readyState = 3;
        }
        private reply(arr: number[]): void {
          const b = Uint8Array.from(arr);
          queueMicrotask(() => this.onmessage?.({ data: b.buffer }));
        }
      }
      const mqtt = new Tier2Mqtt({ url: 'wss://broker', wsFactory: () => new LoopWs() });
      await mqtt.connect();
      const telemetry: string[] = [];
      mqtt.subscribe('dev/1/telemetry', (m) => telemetry.push(m.payload)); // observe what the device publishes
      await Promise.resolve();

      const { entry, segs } = elfLoad(fw);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const adc = new C3Adc();
      adc.set(34, 2750);
      const cpu = new Rv32Cpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, adc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(new Tier1Network({ connectPolls: 3 }), mqtt));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(2, 0x30000);

      let injected = false;
      for (let batch = 0; batch < 3000 && gpio.level(2) !== 1; batch++) {
        for (let k = 0; k < 100_000 && gpio.level(2) !== 1; k++) {
          try {
            cpu.step();
          } catch (e) {
            if (e instanceof Rv32Trap) break;
            throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 2)); // let the WS echoes route through Tier2Mqtt
        if (!injected && telemetry.length > 0) {
          mqtt.publish('dev/1/cmd', '1'); // the "cloud" commands the relay over MQTT-over-WS
          injected = true;
        }
      }

      expect(uart.text()).toContain('WiFi up');
      expect(telemetry).toContain('2750'); // device published telemetry over the MQTT WebSocket
      expect(gpio.level(2)).toBe(1); // device received the command over the MQTT WebSocket → relay on
    }, 180000);

    it('COMBINATION: a smart node (WiFi + 2 sensors + 2 actuators + MQTT) runs end-to-end', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // pot/temp on ADC34 + a button on GPIO4 → publish both; PWM (LEDC) follows the pot; a relay
      // (GPIO2) follows the cloud command. Everything at once — network + analog + digital + PWM.
      const sketch =
        '#include <Arduino.h>\n#include <WiFi.h>\n#include <SparkNet.h>\n' +
        'void setup(){ Serial.begin(115200); pinMode(2,OUTPUT); pinMode(4,INPUT); ledcAttach(15,5000,8);' +
        ' WiFi.begin("sparklab","secret"); while(WiFi.status()!=WL_CONNECTED){delay(10);} Serial.println("WiFi up"); Mqtt.subscribe("dev/1/cmd"); }\n' +
        'void loop(){ int pot=analogRead(34); int btn=digitalRead(4); Mqtt.publish("dev/1/temp", pot); Mqtt.publish("dev/1/btn", btn);' +
        ' ledcWrite(15, pot>>4); int relay=0; while(Mqtt.available()){ int c; while((c=Mqtt.read())!=0){ if(c==0x31) relay=1; } Mqtt.next(); }' +
        ' digitalWrite(2, relay?HIGH:LOW); Serial.println("tick"); delay(20); }\n';
      const fw = await buildFirmware(tc, sketch);

      const broker = new FakeMqttBroker();
      const temps: string[] = [];
      const btns: string[] = [];
      broker.subscribe('dev/1/temp', (m) => temps.push(m.payload));
      broker.subscribe('dev/1/btn', (m) => btns.push(m.payload));

      const { entry, segs } = elfLoad(fw);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const adc = new C3Adc();
      const ledc = new C3Ledc();
      adc.set(34, 2750); // pot reading
      gpio.setInput(4, 1); // button pressed
      const cpu = new Rv32Cpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, adc);
      bus.map(C3_LEDC_BASE, 0x100, ledc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(C3_NET_BASE, 0x100, new C3Net(new Tier1Network({ connectPolls: 3 }), broker));
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(2, 0x30000);

      let injected = false;
      for (let k = 0; k < 8_000_000 && gpio.level(2) !== 1; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof Rv32Trap) break;
          throw e;
        }
        if (!injected && temps.length > 0) {
          broker.inject('dev/1/cmd', '1');
          injected = true;
        }
      }

      expect(uart.text()).toContain('WiFi up');
      expect(temps).toContain('2750'); // sensor 1 (pot/ADC) published
      expect(btns).toContain('1'); // sensor 2 (button/GPIO-in) published
      expect(ledc.duty[15]).toBe(2750 >> 4); // PWM actuator follows the pot
      expect(gpio.level(2)).toBe(1); // relay actuator follows the cloud command
      expect(gpio.enable & (1 << 2)).toBeTruthy(); // GPIO2 configured as output
    }, 180000);

    it('KITCHEN-SINK devkit (single user): 3 sensors + 3 actuators + WiFi + MQTT + HTTP at once', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      // The maximal smart node: pot (ADC34) + light (ADC35) + button (GPIO4) sensors; status LED
      // (GPIO2) + PWM fan (LEDC15) + relay (GPIO5) actuators; WiFi; MQTT (publish temp+light,
      // subscribe a command) AND HTTP (POST) — all driven from one loop().
      const sketch =
        '#include <Arduino.h>\n#include <WiFi.h>\n#include <SparkNet.h>\n' +
        'void setup(){ Serial.begin(115200); pinMode(2,OUTPUT); pinMode(5,OUTPUT); pinMode(4,INPUT); ledcAttach(15,5000,8);' +
        ' WiFi.begin("sparklab","secret"); while(WiFi.status()!=WL_CONNECTED){delay(10);} Serial.println("WiFi up"); Mqtt.subscribe("dev/1/cmd"); }\n' +
        'void loop(){ int pot=analogRead(34); int light=analogRead(35); int btn=digitalRead(4);' +
        ' digitalWrite(2,btn); ledcWrite(15, pot>>4); Mqtt.publish("dev/1/temp", pot); Mqtt.publish("dev/1/light", light);' +
        ' Http.begin("iot.local",80,"/telemetry"); int code=Http.postValue(pot); int relay=0;' +
        ' while(Mqtt.available()){ int c; while((c=Mqtt.read())!=0){ if(c==0x31) relay=1; } Mqtt.next(); }' +
        ' digitalWrite(5, relay); if(code==200) Serial.println("ok"); delay(20); }\n';
      const fw = await buildFirmware(tc, sketch);

      let httpSaw = -1;
      const httpServer = new FakeHttpServer().route('iot.local', (req) => {
        httpSaw = Number(req.body.replace('VAL=', ''));
        return { status: 200, body: '0' };
      });
      const broker = new FakeMqttBroker();
      const temps: string[] = [];
      const lights: string[] = [];
      broker.subscribe('dev/1/temp', (m) => temps.push(m.payload));
      broker.subscribe('dev/1/light', (m) => lights.push(m.payload));

      const { entry, segs } = elfLoad(fw);
      const bus = new SimpleBus(new Uint8Array(0x40000));
      const gpio = new C3Gpio();
      const uart = new C3Uart();
      const adc = new C3Adc();
      const ledc = new C3Ledc();
      adc.set(34, 2750); // pot
      adc.set(35, 1500); // light
      gpio.setInput(4, 1); // button pressed
      const cpu = new Rv32Cpu(bus);
      bus.map(C3_UART0_BASE, 0x80, uart);
      bus.map(C3_GPIO_BASE, 0x800, gpio);
      bus.map(C3_ADC_BASE, 0x100, adc);
      bus.map(C3_LEDC_BASE, 0x100, ledc);
      bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 50));
      bus.map(
        C3_NET_BASE,
        0x100,
        new C3Net(new Tier1Network({ connectPolls: 3, server: httpServer }), broker),
      );
      for (const s of segs) bus.ram.set(s.data, s.addr);
      cpu.pc = entry;
      cpu.setReg(2, 0x30000);

      let injected = false;
      for (let k = 0; k < 10_000_000 && gpio.level(5) !== 1; k++) {
        try {
          cpu.step();
        } catch (e) {
          if (e instanceof Rv32Trap) break;
          throw e;
        }
        if (!injected && temps.length >= 2) {
          broker.inject('dev/1/cmd', '1'); // cloud commands the relay (after ≥1 full loop)
          injected = true;
        }
      }

      expect(uart.text()).toContain('WiFi up');
      expect(uart.text()).toContain('ok'); // HTTP 200 round-tripped
      // sensors
      expect(temps).toContain('2750'); // pot → MQTT
      expect(lights).toContain('1500'); // light → MQTT
      expect(httpSaw).toBe(2750); // pot → HTTP
      // actuators
      expect(gpio.level(2)).toBe(1); // status LED follows the button
      expect(ledc.duty[15]).toBe(2750 >> 4); // PWM fan follows the pot
      expect(gpio.level(5)).toBe(1); // relay follows the MQTT command
    }, 180000);
  },
);
