/**
 * STAGE 4 — drives the real WASM RISC-V toolchain (clang.mjs + lld.mjs we cross-built)
 * through WasmRiscvToolchain to compile a REAL Arduino ESP32-C3 sketch (Arduino.h /
 * HardwareSerial / pinMode / digitalWrite) against the SDK headers, 100% in-process.
 * Node stands in for the browser Worker; backend_compile_count stays 0 (invariant I8).
 *
 * The SDK header subset a Blink needs (323 headers from clang -M) is committed as a
 * manifest fixture; the (gitignored, [CI/HUMAN]) build tree supplies the bytes. Skips
 * when the wasm toolchain or build tree is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain } from './wasm-riscv-toolchain.js';
import type { ToolInput } from './wasm-tool.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..'); // iot-sim-docs
const BUILD = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build');
const WASM_OUT = join(BUILD, 'wasm-out');
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const manifestPath = join(here, '__fixtures__', 'c3-blink-sdk-manifest.txt');
const wifiManifestPath = join(here, '__fixtures__', 'c3-wifi-sdk-manifest.txt');
const sketchPath = join(BUILD, 'sketches', 'C3Blink', 'buildtree', 'sketch', 'C3Blink.ino.cpp');
const ready =
  existsSync(clangMjs) && existsSync(lldMjs) && existsSync(sketchPath) && existsSync(manifestPath);
const wifiReady = ready && existsSync(wifiManifestPath);

/** Assemble the ESP32-C3 SDK header bundle + the verified clang compile flags. */
function buildC3Sdk(): { sdk: ToolInput[]; args: string[] } {
  const manifest = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  const sdk: ToolInput[] = manifest.map((rel) => ({
    path: join(BUILD, rel), // mount at the absolute path the flags reference
    bytes: new Uint8Array(readFileSync(join(BUILD, rel))),
  }));
  const pkg = join(BUILD, 'arduino-data', 'packages', 'esp32');
  const gcc = join(pkg, 'tools', 'esp-rv32', '2601');
  const c3 = join(pkg, 'tools', 'esp32c3-libs', '3.3.10');
  const core = join(pkg, 'hardware', 'esp32', '3.3.10');
  const sk = join(BUILD, 'sketches', 'C3Blink');
  const cxx = `${gcc}/riscv32-esp-elf/include/c++/14.2.0`;
  // The Stage-4 ABI-gate-verified recipe: clang against gcc newlib + libstdc++.
  const args = [
    '--target=riscv32-esp-elf',
    '-march=rv32imc_zicsr_zifencei',
    '-mabi=ilp32',
    `--gcc-toolchain=${gcc}`,
    `--sysroot=${gcc}/riscv32-esp-elf`,
    '-stdlib=libstdc++',
    '-nobuiltininc',
    '-isystem',
    `${gcc}/lib/gcc/riscv32-esp-elf/14.2.0/include`,
    '-isystem',
    cxx,
    '-isystem',
    `${cxx}/riscv32-esp-elf/rv32imc_zicsr_zifencei/ilp32`,
    '-isystem',
    `${cxx}/backward`,
    '-isystem',
    `${gcc}/riscv32-esp-elf/include`,
    '-Qunused-arguments',
    '-Wno-unknown-warning-option',
    '-Wno-unknown-attributes',
    '-Wno-unused-command-line-argument',
    '-c',
    '-w',
    '-Os',
    '-fno-rtti',
    '-ffunction-sections',
    '-fdata-sections',
    '-std=gnu++2a',
    '-fexceptions',
    '-fuse-cxa-atexit',
    '-DF_CPU=160000000L',
    '-DARDUINO=10607',
    '-DARDUINO_ESP32C3_DEV',
    '-DARDUINO_ARCH_ESP32',
    '-DESP32=ESP32',
    '-DARDUINO_BOARD="ESP32C3_DEV"',
    '-DARDUINO_VARIANT="esp32c3"',
    '-DARDUINO_PARTITION_default',
    '-DARDUINO_HOST_OS="macosx"',
    '-DARDUINO_FQBN="esp32:esp32:esp32c3"',
    '-DARDUINO_USB_MODE=1',
    '-DARDUINO_USB_CDC_ON_BOOT=0',
    '-DCORE_DEBUG_LEVEL=0',
    `@${c3}/flags/defines`,
    '-iprefix',
    `${c3}/include/`,
    `@${c3}/flags/includes`,
    `-I${c3}/qio_qspi/include`,
    `-I${core}/cores/esp32`,
    `-I${core}/variants/esp32c3`,
    `-I${sk}`,
  ];
  return { sdk, args };
}

/** The C3 SDK bundle plus the bundled WiFi / Network library headers (gate #4). */
function buildWifiSdk(): { sdk: ToolInput[]; args: string[] } {
  const base = buildC3Sdk();
  const manifest = readFileSync(wifiManifestPath, 'utf8').split('\n').filter(Boolean);
  const sdk: ToolInput[] = manifest.map((rel) => ({
    path: join(BUILD, rel),
    bytes: new Uint8Array(readFileSync(join(BUILD, rel))),
  }));
  const libs = join(
    BUILD,
    'arduino-data',
    'packages',
    'esp32',
    'hardware',
    'esp32',
    '3.3.10',
    'libraries',
  );
  const args = [
    ...base.args,
    `-I${libs}/WiFi/src`,
    `-I${libs}/Network/src`,
    `-I${libs}/NetworkClientSecure/src`,
    `-I${libs}/FS/src`,
  ];
  return { sdk, args };
}

describe.skipIf(!ready)('WasmRiscvToolchain — real ESP32-C3 sketch, client-side', () => {
  it('compiles a real Arduino C3 sketch (Arduino.h/HardwareSerial) to a RISC-V object', async () => {
    const clang = (await import(clangMjs)).default;
    const lld = (await import(lldMjs)).default;
    const tc = new WasmRiscvToolchain({ clang, lld });
    const { sdk, args } = buildC3Sdk();
    const source = new Uint8Array(readFileSync(sketchPath));

    const r = await tc.compile({ args, sdk, sourcePath: sketchPath, sourceBytes: source });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.object.length).toBeGreaterThan(0);
    // valid little-endian ELF32, machine = EM_RISCV (243)
    expect([r.object[0], r.object[1], r.object[2], r.object[3]]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(r.object[18]! | (r.object[19]! << 8)).toBe(243);
  }, 120000);

  it('is reproducible: compiling the same sketch twice yields byte-identical objects (I5)', async () => {
    const clang = (await import(clangMjs)).default;
    const lld = (await import(lldMjs)).default;
    const tc = new WasmRiscvToolchain({ clang, lld });
    const { sdk, args } = buildC3Sdk();
    const source = new Uint8Array(readFileSync(sketchPath));

    const a = await tc.compile({ args, sdk, sourcePath: sketchPath, sourceBytes: source });
    const b = await tc.compile({ args, sdk, sourcePath: sketchPath, sourceBytes: source });
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(Array.from(a.object)).toEqual(Array.from(b.object));
  }, 120000);

  it('surfaces compile diagnostics for a broken sketch (no silent failure)', async () => {
    const clang = (await import(clangMjs)).default;
    const lld = (await import(lldMjs)).default;
    const tc = new WasmRiscvToolchain({ clang, lld });
    const { sdk, args } = buildC3Sdk();
    const bad =
      '#include <Arduino.h>\nvoid setup(){ this_symbol_does_not_exist(); }\nvoid loop(){}\n';

    const r = await tc.compile({ args, sdk, sourcePath: sketchPath, sourceBytes: bad });
    expect(r.exitCode).not.toBe(0);
    expect(r.object.length).toBe(0);
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  }, 120000);
});

describe.skipIf(!wifiReady)(
  'WasmRiscvToolchain — network library compile (Stage 4 gate #4)',
  () => {
    it('compiles a WiFi sketch — the full arduino-esp32 WiFi/Network stack headers', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const { sdk, args } = buildWifiSdk();
      const wifi =
        '#include <Arduino.h>\n#include <WiFi.h>\n' +
        'void setup(){ Serial.begin(115200); WiFi.begin("ssid", "pass"); }\n' +
        'void loop(){ if (WiFi.status() == WL_CONNECTED) { Serial.println(WiFi.localIP()); } delay(1000); }\n';

      const r = await tc.compile({ args, sdk, sourcePath: '/wifi/sketch.cpp', sourceBytes: wifi });
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(r.object[18]! | (r.object[19]! << 8)).toBe(243); // EM_RISCV — a real RISC-V object
    }, 120000);
  },
);
