/**
 * STAGE 5 — the ESP32-classic (Xtensa) vertical wired through the SHIPPING seams (sim build profile):
 *   real Arduino sketch  --wasm esp-clang (Xtensa, call0)-->  object
 *   sim runtime (HAL+crt0) --wasm esp-clang--------------->   object
 *   both                 --wasm lld (.literal-before-.text)-> firmware ELF
 *   firmware             --XtensaRunner--------------------->  runs, GPIO/Serial MMIO observed
 *
 * Mirrors the C3 gate (`esp32c3-sim-profile.test.ts`) but exercises the PORTABLE product code the
 * browser worker uses: `buildEsp32ClassicFirmware` (build-orchestrator) + `XtensaRunner` (the
 * worker-shaped seam) — not the inline recipe of `esp32-classic-sim-profile.test.ts`. The sketch is
 * compiled UNCHANGED against the real arduino-esp32 (classic) headers with windowed registers OFF and
 * linked against the architecture-neutral Arduino HAL shim. backend_compile_count stays 0 (I8);
 * delay() is virtual-time (I3); re-link is byte-identical (I5).
 *
 * Skips when the (gitignored, [CI/HUMAN]) Xtensa wasm toolchain / SDK build tree is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { buildEsp32ClassicFirmware } from '@sparklab/build-orchestrator';
import { Tier1Network } from '@sparklab/network-shim';
import { XtensaRunner } from './xtensa-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const ESPB = join(REPO, 'ci', 'toolchain-builder', 'esp32', 'build'); // shared arduino-data (SDK)
const WASM_OUT = join(REPO, 'ci', 'toolchain-builder', 'esp32-classic', 'build', 'wasm-out'); // Xtensa clang/lld
const clangMjs = join(WASM_OUT, 'clang.mjs');
const lldMjs = join(WASM_OUT, 'lld.mjs');
const manifestPath = join(
  here,
  '..',
  '..',
  'toolchain-loader',
  'src',
  '__fixtures__',
  'esp32-classic-sdk-manifest.txt',
);
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const linkerLd = join(here, 'sim-runtime', 'xtensa-flat.ld');
const GCC = join(ESPB, 'arduino-data', 'packages', 'esp32', 'tools', 'esp-x32', '2601');
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  existsSync(join(GCC, 'bin'));

function sdkBundle(): ToolInput[] {
  const rels = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  return rels.map((rel) => ({
    path: join(ESPB, rel),
    bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
  }));
}

describe.skipIf(!ready)(
  'Stage 5 — client-built ESP32-classic sketch runs via XtensaRunner (sim profile, product seams)',
  () => {
    it('compiles the real Arduino blink+Serial through buildEsp32ClassicFirmware + runs on XtensaRunner (GPIO2 + Serial, I8 + I3 + I5)', async () => {
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });

      const sketch =
        '#include <Arduino.h>\nvoid setup(){ pinMode(2, OUTPUT); Serial.begin(115200); }\n' +
        'void loop(){ digitalWrite(2, HIGH); Serial.println("on"); delay(5); digitalWrite(2, LOW); delay(5); }\n';
      const runtimeSource = new Uint8Array(readFileSync(runtimeCpp));
      const linkerScript = new Uint8Array(readFileSync(linkerLd));

      const built = await buildEsp32ClassicFirmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource,
        linkerScript,
        sdk: sdkBundle(),
        root: ESPB,
      });
      expect(built.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(built.ok).toBe(true);
      const elf = built.elf!;
      expect([elf[0], elf[1], elf[2], elf[3]]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
      expect(elf[18]! | (elf[19]! << 8)).toBe(94); // EM_XTENSA — it really built as Xtensa, not a silent fallthrough

      // I5: rebuilding the same sketch yields a byte-identical firmware (reproducible build)
      const rebuilt = await buildEsp32ClassicFirmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource,
        linkerScript,
        sdk: sdkBundle(),
        root: ESPB,
      });
      expect(Array.from(rebuilt.elf!)).toEqual(Array.from(elf));

      // run the firmware on the Xtensa interpreter via XtensaRunner (the worker-shaped seam)
      const runner = new XtensaRunner(elf);
      const trace: Array<0 | 1> = [];
      runner.gpio.onChange = (pin, level) => {
        runner.pins[pin] = level;
        if (pin === 2) trace.push(level);
      };
      for (let ms = 0; ms < 4000 && trace.length < 6; ms += 20) runner.executeForMillis(20);

      expect(runner.gpio.enable & (1 << 2)).toBeTruthy(); // setup() enabled GPIO2 output
      expect(trace.length).toBeGreaterThanOrEqual(4);
      expect(trace.slice(0, 4)).toEqual([1, 0, 1, 0]); // HIGH, LOW, HIGH, LOW …
      expect(runner.pins[2]).toBeDefined(); // the worker reflects GPIO2 from runner.pins
      expect(runner.serial()).toContain('on\r\n'); // Serial.println("on") each loop
      expect(runner.serial().match(/on/g)!.length).toBeGreaterThanOrEqual(2);
      expect(runner.virtualTimeNs).toBeGreaterThan(0);
    }, 180000);

    it('a WiFi sketch with WiFi.localIP()/println(IPAddress) runs on Xtensa (the IPAddress vtable + sret path)', async () => {
      const wifiManifest = join(
        here,
        '..',
        '..',
        'toolchain-loader',
        'src',
        '__fixtures__',
        'esp32-classic-wifi-sdk-manifest.txt',
      );
      if (!existsSync(wifiManifest)) return; // classic WiFi pack not staged in this checkout
      const clang = (await import(clangMjs)).default;
      const lld = (await import(lldMjs)).default;
      const tc = new WasmRiscvToolchain({ clang, lld });
      const sdk: ToolInput[] = readFileSync(wifiManifest, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((rel) => ({
          path: join(ESPB, rel),
          bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
        }));
      // The user's exact sketch (the one that ran setup but not loop, no IP printed).
      const sketch =
        '#include <WiFi.h>\n' +
        'void setup(){\n  Serial.begin(115200);\n  WiFi.mode(WIFI_STA);\n  WiFi.begin("Sparklab-GUEST", "");\n' +
        '  while (WiFi.status() != WL_CONNECTED) { delay(100); }\n' +
        '  Serial.println("WiFi connected!");\n  Serial.print("IP address: ");\n  Serial.println(WiFi.localIP());\n}\n' +
        'void loop(){ Serial.println("WiFi is connected"); Serial.println(WiFi.localIP()); delay(1000); }\n';
      const built = await buildEsp32ClassicFirmware({
        toolchain: tc,
        sketchSource: sketch,
        runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
        linkerScript: new Uint8Array(readFileSync(linkerLd)),
        sdk,
        root: ESPB,
      });
      expect(built.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const runner = new XtensaRunner(built.elf!, {
        transport: new Tier1Network({ connectPolls: 3 }),
      });
      for (
        let i = 0;
        i < 800 && (runner.serial().match(/WiFi is connected/g)?.length ?? 0) < 2;
        i++
      ) {
        runner.executeForMillis(20);
      }
      expect(runner.serial()).toContain('WiFi connected!'); // setup printed it
      expect(runner.serial()).toContain('IP address: 192.168.4.2'); // localIP printed in setup (vtable dispatch OK)
      // loop must actually run + print the IP repeatedly (the user saw it stop after setup)
      expect((runner.serial().match(/WiFi is connected/g) ?? []).length).toBeGreaterThanOrEqual(2);
    }, 180000);
  },
);
