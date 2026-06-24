/**
 * PRODUCTION-ARTIFACT gate for the ESP32-classic (Xtensa) path: builds a real-picolibc sketch from the
 * SHIPPED pack (`packages/app/public/esp32-classic-toolchain/esp32-classic-sdk.json`) exactly the way the
 * browser build worker does — mounting the pack's `archives` (libc.a/libm.a/libgcc.a) at /libc.a etc.,
 * the header `files` under the SDK root, and the embedded `runtime` + `linker`. This proves the fixture
 * script (`make-esp32-classic-fixtures.mjs`) shipped the RIGHT archive bytes and that `build.worker.ts`
 * passes them through, so production sketches link real picolibc (snprintf %d/%s) — not just the on-disk
 * test in esp32-classic-libc.test.ts. Skips when the gitignored pack/toolchain are absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { buildEsp32ClassicFirmware } from '@sparklab/build-orchestrator';
import { XtensaRunner } from './xtensa-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = join(here, '..', '..', 'app', 'public', 'esp32-classic-toolchain');
const clangMjs = join(PACK_DIR, 'clang.mjs');
const lldMjs = join(PACK_DIR, 'lld.mjs');
const sdkJson = join(PACK_DIR, 'esp32-classic-sdk.json');
const ROOT = '/esp32-classic-sdk'; // = XTENSA_SDK_ROOT in real-xtensa-toolchain.ts

const b64 = (s: string): Uint8Array => {
  const buf = Buffer.from(s, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

interface Pack {
  files: { path: string; b64: string }[];
  runtime: string;
  linker: string;
  archives?: { name: string; b64: string }[];
}
const ready = existsSync(clangMjs) && existsSync(lldMjs) && existsSync(sdkJson);
const pack: Pack | null = ready ? (JSON.parse(readFileSync(sdkJson, 'utf8')) as Pack) : null;
// The whole point: the shipped pack must carry the stdlib archives.
const hasArchives = !!pack && Array.isArray(pack.archives) && pack.archives.length >= 3;

describe.skipIf(!ready)(
  'ESP32-classic SHIPPED PACK — real picolibc links from the production artifact',
  () => {
    it('the pack embeds the libc/libm/libgcc archives', () => {
      expect(
        hasArchives,
        'esp32-classic-sdk.json must contain ≥3 stdlib archives (regen: pnpm esp32-classic-fixtures)',
      ).toBe(true);
      expect(pack!.archives!.map((a) => a.name).sort()).toEqual(['libc.a', 'libgcc.a', 'libm.a']);
    });

    it.skipIf(!hasArchives)(
      'builds + runs snprintf(%d/%s) from the packed archives, exactly like the worker',
      async () => {
        const clang = (await import(clangMjs)).default;
        const lld = (await import(lldMjs)).default;
        const tc = new WasmRiscvToolchain({ clang, lld });
        // Mount the pack exactly as loadRealXtensaToolchain does: headers under ROOT, archives at /<name>.
        const sdk: ToolInput[] = pack!.files.map((f) => ({
          path: `${ROOT}/${f.path}`,
          bytes: b64(f.b64),
        }));
        const archives = pack!.archives!.map((a) => ({ path: `/${a.name}`, bytes: b64(a.b64) }));
        const sketch =
          '#include <Arduino.h>\n#include <string.h>\n#include <stdlib.h>\n' +
          'void setup(){\n' +
          '  Serial.begin(115200);\n' +
          '  char* heap = (char*)malloc(16); strcpy(heap, "hi");\n' +
          '  char b[64];\n' +
          '  snprintf(b, sizeof(b), "v=%d %s len=%d", 42, heap, (int)strlen(heap));\n' +
          '  free(heap);\n' +
          '  Serial.println(b);\n' +
          '  Serial.println("end");\n' +
          '}\nvoid loop(){}\n';
        const built = await buildEsp32ClassicFirmware({
          toolchain: tc,
          sketchSource: sketch,
          runtimeSource: b64(pack!.runtime),
          linkerScript: b64(pack!.linker),
          sdk,
          root: ROOT,
          archives,
        });
        if (!built.ok)
          console.log(
            'PACK LINK DIAG:\n' +
              built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n'),
          );
        expect(built.ok).toBe(true);

        const runner = new XtensaRunner(built.elf!);
        for (let i = 0; i < 600 && !/end/.test(runner.serial()) && !runner.halted; i++)
          runner.executeForMillis(20);
        expect(runner.haltReason, `halted: ${runner.haltReason}`).toBeNull();
        expect(runner.serial()).toContain('v=42 hi len=2'); // real picolibc, from the shipped pack
      },
      180000,
    );
  },
);
