/**
 * ESP32-classic (Xtensa) REAL printf/snprintf format-conversion coverage + sscanf.
 *
 * Drives picolibc's tinystdio vfprintf (`__d_vfprintf`/`__f_vfprintf` + `__dtoa_engine`/`fcvt`)
 * through MANY conversions and flags, plus vfscanf via sscanf. Each result string is produced by
 * the REAL libc snprintf running on the interpreted Xtensa CPU and emitted verbatim through the
 * Serial(const char*) shim, so this isolates vfprintf/vfscanf + double soft-float from the shim's
 * own number printer. Integer conversions exercise the field-pick/shift ops; %f/%e/%g/%a exercise
 * the FP-option soft-float (divide/sqrt seeds + MKSADJ/MKDADJ) and the dtoa engine; %lld/%llu
 * exercise the 64-bit integer paths. A wrong opcode/operand decode TRAPs (runner.haltReason) or
 * MISCOMPUTEs (string mismatch). Skips when the toolchain/archives are absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WasmRiscvToolchain, type ToolInput } from '@sparklab/toolchain-loader';
import { buildEsp32ClassicFirmware } from '@sparklab/build-orchestrator';
import { XtensaRunner } from './xtensa-runner.js';

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
const linkerLd = join(here, 'sim-runtime', 'xtensa-flat.ld');
const X = join(ESPB, 'arduino-data', 'packages', 'esp32', 'tools', 'esp-x32', '2601');
const ARCHIVES: [string, string][] = [
  ['/libc.a', join(X, 'picolibc', 'xtensa-esp-elf', 'lib', 'esp32', 'libc.a')],
  ['/libm.a', join(X, 'picolibc', 'xtensa-esp-elf', 'lib', 'esp32', 'libm.a')],
  ['/libgcc.a', join(X, 'picolibc', 'lib', 'gcc', 'xtensa-esp-elf', '14.2.0', 'esp32', 'libgcc.a')],
];
const ready =
  existsSync(clangMjs) &&
  existsSync(lldMjs) &&
  existsSync(manifestPath) &&
  ARCHIVES.every(([, p]) => existsSync(p));

const sdkBundle = (): ToolInput[] =>
  readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((rel) => ({
      path: join(ESPB, rel),
      bytes: new Uint8Array(readFileSync(join(ESPB, rel))),
    }));

async function buildAndRun(
  sketch: string,
  maxIters = 1200,
): Promise<{ serial: string; haltReason: string | null; ok: boolean; diag: string }> {
  const clang = (await import(clangMjs)).default;
  const lld = (await import(lldMjs)).default;
  const tc = new WasmRiscvToolchain({ clang, lld });
  const built = await buildEsp32ClassicFirmware({
    toolchain: tc,
    sketchSource: sketch,
    runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
    linkerScript: new Uint8Array(readFileSync(linkerLd)),
    sdk: sdkBundle(),
    root: ESPB,
    archives: ARCHIVES.map(([path, p]) => ({ path, bytes: new Uint8Array(readFileSync(p)) })),
  });
  const diag = built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n');
  if (!built.ok) return { serial: '', haltReason: null, ok: false, diag };
  const runner = new XtensaRunner(built.elf!);
  for (let i = 0; i < maxIters && !/__END__/.test(runner.serial()) && !runner.halted; i++)
    runner.executeForMillis(20);
  return { serial: runner.serial(), haltReason: runner.haltReason, ok: true, diag };
}

// Common preamble: pull snprintf/sscanf from the SDK's <stdio.h> (Arduino.h is already in; a manual extern
// re-declaration with `unsigned long` conflicts with the SDK's size_t prototype — that broke this whole suite).
const PRE =
  '#include <Arduino.h>\n' +
  '#include <stdio.h>\n' +
  'static char B[160];\n' +
  // emit "LABEL=<formatted>" then newline, so the test can grep exact substrings.
  '#define EMIT(label, ...) do { snprintf(B, sizeof(B), __VA_ARGS__); Serial.print(label); Serial.print("="); Serial.println(B); } while(0)\n';

describe.skipIf(!ready)('ESP32-classic (Xtensa) — printf/snprintf format coverage + sscanf', () => {
  it('integer conversions + flags (%d %i %u %x %X %o %c %s %% width/precision/pad/justify/sign)', async () => {
    const sketch =
      PRE +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  EMIT("D",   "%d", -42);\n' + // -42
      '  EMIT("I",   "%i", 12345);\n' + // 12345
      '  EMIT("U",   "%u", 4000000000u);\n' + // 4000000000
      '  EMIT("X",   "%x", 0xdeadbeefu);\n' + // deadbeef
      '  EMIT("XU",  "%X", 0xCAFEu);\n' + // CAFE
      '  EMIT("O",   "%o", 64);\n' + // 100
      '  EMIT("C",   "%c", 65);\n' + // A
      '  EMIT("S",   "%s", "hi");\n' + // hi
      '  EMIT("PCT", "%%");\n' + // %
      '  EMIT("Z5",  "%05d", 42);\n' + // 00042
      '  EMIT("LJ",  "[%-8d]", 7);\n' + // [7       ]
      '  EMIT("RJ",  "[%8d]", 7);\n' + // [       7]
      '  EMIT("PLUS","%+d", 5);\n' + // +5
      '  EMIT("SPC", "% d", 5);\n' + // " 5"
      '  EMIT("HASH","%#x", 255);\n' + // 0xff
      '  EMIT("HSO", "%#o", 8);\n' + // 010
      '  EMIT("PREC","%.3d", 7);\n' + // 007
      '  EMIT("WP",  "%8.3d", 7);\n' + // "     007"
      '  EMIT("STRP","%.2s", "abcdef");\n' + // ab
      '  EMIT("MIX", "<%+06.2d|%-5s|%#X>", 3, "ok", 171);\n' + // <+00003|ok   |0XAB>
      '  Serial.println("__END__");\n' +
      '}\nvoid loop(){}\n';
    const r = await buildAndRun(sketch);
    if (!r.ok) console.log('INT LINK DIAG:\n' + r.diag);
    expect(r.ok, 'link failed').toBe(true);
    expect(r.haltReason, `halted: ${r.haltReason}`).toBeNull();
    const s = r.serial;
    expect(s).toContain('D=-42');
    expect(s).toContain('I=12345');
    expect(s).toContain('U=4000000000');
    expect(s).toContain('X=deadbeef');
    expect(s).toContain('XU=CAFE');
    expect(s).toContain('O=100');
    expect(s).toContain('C=A');
    expect(s).toContain('S=hi');
    expect(s).toContain('PCT=%');
    expect(s).toContain('Z5=00042');
    expect(s).toContain('LJ=[7       ]');
    expect(s).toContain('RJ=[       7]');
    expect(s).toContain('PLUS=+5');
    expect(s).toContain('SPC= 5');
    expect(s).toContain('HASH=0xff');
    expect(s).toContain('HSO=010');
    expect(s).toContain('PREC=007');
    expect(s).toContain('WP=     007');
    expect(s).toContain('STRP=ab');
    // %+06.2d of 3: precision 2 → "03", '+' → "+03"; the '0' flag is IGNORED when a precision is given for an
    // integer (C standard), so width 6 space-pads → "   +03". picolibc matches the host printf exactly.
    expect(s).toContain('MIX=<   +03|ok   |0XAB>');
  }, 180000);

  it('64-bit length modifiers (%ld %lu %lld %llu %llx) — soft 64-bit integer paths', async () => {
    const sketch =
      PRE +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  EMIT("LD",   "%ld", -2000000000L);\n' + // -2000000000
      '  EMIT("LU",   "%lu", 4000000000UL);\n' + // 4000000000
      '  EMIT("LLD",  "%lld", -9000000000000000000LL);\n' + // -9000000000000000000
      '  EMIT("LLU",  "%llu", 18000000000000000000ULL);\n' + // 18000000000000000000
      '  EMIT("LLX",  "%llx", 0x1122334455667788ULL);\n' + // 1122334455667788
      '  EMIT("LLD2", "%lld", 1234567890123LL);\n' + // 1234567890123
      '  EMIT("LLPAD","%020lld", 42LL);\n' + // 00000000000000000042
      '  Serial.println("__END__");\n' +
      '}\nvoid loop(){}\n';
    const r = await buildAndRun(sketch);
    if (!r.ok) console.log('LL LINK DIAG:\n' + r.diag);
    expect(r.ok, 'link failed').toBe(true);
    expect(r.haltReason, `halted: ${r.haltReason}`).toBeNull();
    const s = r.serial;
    expect(s).toContain('LD=-2000000000');
    expect(s).toContain('LU=4000000000');
    expect(s).toContain('LLD=-9000000000000000000');
    expect(s).toContain('LLU=18000000000000000000');
    expect(s).toContain('LLX=1122334455667788');
    expect(s).toContain('LLD2=1234567890123');
    expect(s).toContain('LLPAD=00000000000000000042');
  }, 180000);

  it('float/double conversions %f %e %g %a (vfprintf + double soft-float + dtoa)', async () => {
    // volatile defeats constant folding so the real soft-float + dtoa run on the CPU.
    const sketch =
      PRE +
      'static volatile double pi = 3.14159265358979, big = 123456.789, small = 0.000123, neg = -2.5;\n' +
      'static volatile double half = 0.5, zero = 0.0, ten = 10.0;\n' +
      'static volatile float fpi = 3.14159f;\n' +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  EMIT("F",   "%f", pi);\n' + // 3.141593
      '  EMIT("F2",  "%.2f", pi);\n' + // 3.14
      '  EMIT("FW",  "%10.3f", pi);\n' + // "     3.142"
      '  EMIT("FLJ", "[%-8.2f]", neg);\n' + // [-2.50   ]
      '  EMIT("FZ",  "%08.2f", neg);\n' + // -0002.50
      '  EMIT("FPL", "%+.1f", half);\n' + // +0.5
      '  EMIT("F0",  "%.0f", ten);\n' + // 10
      '  EMIT("E",   "%e", big);\n' + // 1.234568e+05
      '  EMIT("E2",  "%.2e", big);\n' + // 1.23e+05
      '  EMIT("EU",  "%E", small);\n' + // 1.230000E-04
      '  EMIT("G",   "%g", big);\n' + // 123457
      '  EMIT("G2",  "%g", small);\n' + // 0.000123
      '  EMIT("GP",  "%.3g", pi);\n' + // 3.14
      '  EMIT("FF",  "%f", (double)fpi);\n' + // 3.141590
      '  EMIT("ZF",  "%.1f", zero);\n' + // 0.0
      '  Serial.println("__END__");\n' +
      '}\nvoid loop(){}\n';
    const r = await buildAndRun(sketch);
    if (!r.ok) console.log('FLOAT LINK DIAG:\n' + r.diag);
    expect(r.ok, 'link failed').toBe(true);
    expect(r.haltReason, `halted: ${r.haltReason}`).toBeNull();
    const s = r.serial;
    expect(s).toContain('F=3.141593');
    expect(s).toContain('F2=3.14');
    expect(s).toContain('FW=     3.142');
    expect(s).toContain('FLJ=[-2.50   ]');
    expect(s).toContain('FZ=-0002.50');
    expect(s).toContain('FPL=+0.5');
    expect(s).toContain('F0=10');
    expect(s).toContain('E=1.234568e+05');
    expect(s).toContain('E2=1.23e+05');
    expect(s).toContain('EU=1.230000E-04');
    expect(s).toContain('G=123457');
    expect(s).toContain('G2=0.000123');
    expect(s).toContain('GP=3.14');
    expect(s).toContain('FF=3.141590');
    expect(s).toContain('ZF=0.0');
  }, 180000);

  it('%a hex-float and %p pointer', async () => {
    const sketch =
      PRE +
      'static volatile double one5 = 1.5, two = 2.0;\n' +
      'static int marker = 0;\n' +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  EMIT("A",  "%a", one5);\n' + // 0x1.8p+0
      '  EMIT("A2", "%a", two);\n' + // 0x1p+1
      '  // %p: value varies; just prove it does not TRAP and starts with 0x\n' +
      '  snprintf(B, sizeof(B), "%p", (void*)&marker);\n' +
      '  Serial.print("P="); Serial.println(B);\n' +
      '  Serial.println("__END__");\n' +
      '}\nvoid loop(){}\n';
    const r = await buildAndRun(sketch);
    if (!r.ok) console.log('AP LINK DIAG:\n' + r.diag);
    expect(r.ok, 'link failed').toBe(true);
    expect(r.haltReason, `halted: ${r.haltReason}`).toBeNull();
    const s = r.serial;
    expect(s).toContain('A=0x1.8p+0');
    expect(s).toContain('A2=0x1p+1');
    expect(s).toMatch(/P=0x[0-9a-f]+/);
  }, 180000);

  it('sscanf("%d %f", ...) parses integer + float back from a string', async () => {
    const sketch =
      PRE +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  int iv = 0; float fv = 0.0f;\n' +
      '  int n = sscanf("123 4.5", "%d %f", &iv, &fv);\n' +
      '  EMIT("N", "%d", n);\n' + // 2
      '  EMIT("IV", "%d", iv);\n' + // 123
      '  EMIT("FV", "%d", (int)(fv * 10.0f + 0.5f));\n' + // 45  (4.5*10)
      '  int a=0,b=0,c=0;\n' +
      '  int n2 = sscanf("-7 0xff 010", "%d %x %o", &a, &b, &c);\n' +
      '  EMIT("N2", "%d", n2);\n' + // 3
      '  EMIT("A", "%d", a);\n' + // -7
      '  EMIT("Bx", "%d", b);\n' + // 255
      '  EMIT("Co", "%d", c);\n' + // 8
      '  double dv = 0.0;\n' +
      '  int n3 = sscanf("2.71828e0", "%lf", &dv);\n' +
      '  EMIT("N3", "%d", n3);\n' + // 1
      '  EMIT("DV", "%d", (int)(dv * 1000.0));\n' + // 2718
      '  Serial.println("__END__");\n' +
      '}\nvoid loop(){}\n';
    const r = await buildAndRun(sketch);
    if (!r.ok) console.log('SCANF LINK DIAG:\n' + r.diag);
    expect(r.ok, 'link failed').toBe(true);
    expect(r.haltReason, `halted: ${r.haltReason}`).toBeNull();
    const s = r.serial;
    expect(s).toContain('N=2');
    expect(s).toContain('IV=123');
    expect(s).toContain('FV=45');
    expect(s).toContain('N2=3');
    expect(s).toContain('A=-7');
    expect(s).toContain('Bx=255');
    expect(s).toContain('Co=8');
    expect(s).toContain('N3=1');
    expect(s).toContain('DV=2718');
  }, 180000);

  // Regression for XTENSA-CORE-AUDIT.md #1c deferred item: Serial.print/println of a float/double or a
  // 64-bit integer used to fail to LINK (the Print shim only defined the 32-bit + char* forms). These
  // go through the SHIM's own Print::print(double,int)/print(long long,int) — NOT snprintf EMIT — so
  // they verify the shim overloads themselves (float via snprintf("%.*f"), long long via the 64-bit loop).
  it('Serial.println(float/double) + Serial.println(long long) link and print (shim Print overloads)', async () => {
    const sketch =
      PRE +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  Serial.print("F1="); Serial.println(3.14159, 2);\n' + // F1=3.14 (rounded)
      '  float f = 2.5f;\n' +
      '  Serial.print("F2="); Serial.println(f);\n' + // F2=2.50 (default 2 digits)
      '  Serial.print("F3="); Serial.println(-1.5, 1);\n' + // F3=-1.5
      '  Serial.print("F4="); Serial.println(0.0, 3);\n' + // F4=0.000
      '  Serial.print("LL1="); Serial.println(1234567890123LL);\n' + // LL1=1234567890123
      '  Serial.print("LL2="); Serial.println(-9000000000000000000LL);\n' + // LL2=-9000000000000000000
      '  Serial.print("ULL="); Serial.println(18000000000000000000ULL);\n' + // ULL=18000000000000000000
      '  Serial.print("LLX="); Serial.println((long long)0x1122334455667788LL, 16);\n' + // LLX=1122334455667788
      '  Serial.println("__END__");\n' +
      '}\nvoid loop(){}\n';
    const r = await buildAndRun(sketch);
    if (!r.ok) console.log('FLOAT/LL LINK DIAG:\n' + r.diag);
    expect(r.ok, 'link failed (shim missing Print(double,int)/Print(long long,int)?)').toBe(true);
    expect(r.haltReason, `halted: ${r.haltReason}`).toBeNull();
    const s = r.serial;
    expect(s).toContain('F1=3.14');
    expect(s).toContain('F2=2.50');
    expect(s).toContain('F3=-1.5');
    expect(s).toContain('F4=0.000');
    expect(s).toContain('LL1=1234567890123');
    expect(s).toContain('LL2=-9000000000000000000');
    expect(s).toContain('ULL=18000000000000000000');
    expect(s).toContain('LLX=1122334455667788');
  }, 180000);

  // Regression for XTENSA-CORE-AUDIT.md #1c deferred item 1: a sketch using the Arduino String class +
  // String.toFloat()/.toInt() used to fail to LINK — the core WString.cpp wasn't compiled, and its
  // toFloat/toInt → atof/atol pulled picolibc's strtod/strtol whose errno needs an unresolvable TLS reloc.
  // Now WString.cpp is compiled as a core source (mirroring build.worker's coreSourceLibraries) and the
  // shim provides atof/atol via sscanf. This builds String + its conversions for real and runs them.
  it('Arduino String + String.toFloat()/toInt() link and run (core WString.cpp compiled)', async () => {
    const clang = (await import(clangMjs)).default;
    const lld = (await import(lldMjs)).default;
    const tc = new WasmRiscvToolchain({ clang, lld });
    const sdk = sdkBundle();
    const ws = sdk.find((f) => f.path.endsWith('/cores/esp32/WString.cpp'));
    expect(ws, 'WString.cpp must be in the SDK manifest').toBeTruthy();
    const dir = ws!.path.slice(0, ws!.path.lastIndexOf('/'));
    // Mirror build.worker's coreSourceLibraries: WString.cpp + the Print(const String&) bridge.
    const bridge =
      '#include <Arduino.h>\n' +
      'size_t Print::print(const String &s) { return print(s.c_str()); }\n' +
      'size_t Print::println(const String &s) { return println(s.c_str()); }\n';
    const enc = new TextEncoder();
    const sketch =
      PRE +
      'void setup(){\n' +
      '  Serial.begin(115200);\n' +
      '  String s = "3.14";\n' +
      '  String t = "42";\n' +
      '  Serial.print("TF="); Serial.println(s.toFloat(), 2);\n' + // 3.14
      '  Serial.print("TI="); Serial.println((long)t.toInt());\n' + // 42
      '  String u = s; u += "!";\n' + // concat(const char*) from WString.cpp
      '  Serial.print("CAT="); Serial.println(u);\n' + // 3.14!  (println(const String&) via bridge)
      '  Serial.print("LEN="); Serial.println((long)u.length());\n' + // 5
      '  Serial.println("__END__");\n' +
      '}\nvoid loop(){}\n';
    const built = await buildEsp32ClassicFirmware({
      toolchain: tc,
      sketchSource: sketch,
      runtimeSource: new Uint8Array(readFileSync(runtimeCpp)),
      linkerScript: new Uint8Array(readFileSync(linkerLd)),
      sdk,
      root: ESPB,
      libraries: [
        {
          includePath: dir,
          sources: [
            { path: ws!.path, bytes: ws!.bytes as Uint8Array, language: 'c++' as const },
            {
              path: `${dir}/__sparklab_string_print.cpp`,
              bytes: enc.encode(bridge),
              language: 'c++' as const,
            },
          ],
        },
      ],
      archives: ARCHIVES.map(([path, p]) => ({ path, bytes: new Uint8Array(readFileSync(p)) })),
    });
    const diag = built.diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n');
    if (!built.ok) console.log('STRING LINK DIAG:\n' + diag);
    expect(built.ok, 'link failed (WString.cpp not compiled or strtod/strtol TLS reloc?)').toBe(
      true,
    );
    const runner = new XtensaRunner(built.elf!);
    for (let i = 0; i < 1500 && !/__END__/.test(runner.serial()) && !runner.halted; i++)
      runner.executeForMillis(20);
    expect(runner.haltReason, `halted: ${runner.haltReason}`).toBeNull();
    const s = runner.serial();
    expect(s).toContain('TF=3.14');
    expect(s).toContain('TI=42');
    expect(s).toContain('CAT=3.14!');
    expect(s).toContain('LEN=5');
  }, 180000);
});
