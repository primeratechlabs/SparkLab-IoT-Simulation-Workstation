/**
 * Real AVR toolchain driven entirely in the browser/WASM (REFERENCE-SPEC Stage 2).
 *
 * The gcc driver can't fork cc1/as/ld in WASM, so this class IS the driver: it runs
 * cc1plus → avr-as for compile and avr-ld for link via WasmTool (fresh module per
 * invocation — cc1plus is not re-entrant), mounting the SDK headers/libs into MEMFS.
 * The flag recipe below is exactly what the gcc driver computes for atmega328p/avr5
 * (verified end-to-end in wasm-toolchain.test.ts), including `-Tdata 0x800100` so the
 * .data region lands in SRAM rather than over the I/O registers.
 *
 * Implements the Toolchain interface, so the BuildDaemon uses it in place of the
 * Stage-1 stub with no orchestrator change.
 */

import type { Diagnostic } from '@sparklab/shared';
import type { CompileInput, CompileOutput, LinkInput, LinkOutput, Toolchain } from './types.js';
import { WasmTool, type EmscriptenModuleFactory } from './wasm-tool.js';

export interface AvrToolFactories {
  cc1plus: EmscriptenModuleFactory;
  avrAs: EmscriptenModuleFactory;
  avrLd: EmscriptenModuleFactory;
  /** C compiler — required to compile .c library sources (e.g. Wire's twi.c). */
  cc1?: EmscriptenModuleFactory;
}

export interface SdkFile {
  /** Path relative to the mount point, e.g. "Arduino.h" or "avr/io.h". */
  path: string;
  bytes: Uint8Array;
}

export interface AvrSdk {
  /** Header trees mounted into the compiler FS; mount is an absolute MEMFS dir. */
  headerMounts: { mount: string; files: SdkFile[] }[];
  crt: Uint8Array; // crtatmega328p.o
  coreA: Uint8Array; // ArduinoCore-avr core.a
  libs: { name: string; bytes: Uint8Array }[]; // libgcc.a, libm.a, libc.a, libatmega328p.a
  ldscript: Uint8Array; // avr5.x
}

export interface AvrTargetRecipe {
  id: string; // compiler identity for cache keys, e.g. "avr-gcc-wasm@14.2"
  mmcu: string; // core arch passed to cc1/as/ld, e.g. "avr5"
  deviceDefines: string[]; // ["-D__AVR_ATmega328P__", "-D__AVR_DEVICE_NAME__=atmega328p"]
  dataOrigin: string; // "-Tdata" value, e.g. "0x800100"
  /** Library link order inside --start-group (without the leading -l). */
  linkLibs: string[]; // ["gcc", "m", "c", "atmega328p"]
}

export const ATMEGA328P_RECIPE: AvrTargetRecipe = {
  id: 'avr-gcc-wasm@14.2',
  mmcu: 'avr5',
  deviceDefines: ['-D__AVR_ATmega328P__', '-D__AVR_DEVICE_NAME__=atmega328p'],
  dataOrigin: '0x800100',
  linkLibs: ['gcc', 'm', 'c', 'atmega328p'],
};

function diag(severity: Diagnostic['severity'], message: string): Diagnostic {
  return { severity, file: '<toolchain>', line: 0, message };
}

/** Parse cc1plus/as/ld stderr into diagnostics (best-effort, file:line:col: sev: msg). */
function parseDiagnostics(stderr: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/^(.*?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.*)$/);
    if (m) {
      out.push({
        severity: m[4] as Diagnostic['severity'],
        file: m[1]!,
        line: Number(m[2]),
        ...(m[3] ? { column: Number(m[3]) } : {}),
        message: m[5]!,
      });
    } else if (/\berror\b/i.test(line) && line.trim()) {
      out.push(diag('error', line.trim()));
    }
  }
  return out;
}

export class WasmAvrToolchain implements Toolchain {
  readonly id: string;
  private readonly cc1plus: WasmTool;
  private readonly cc1: WasmTool | null;
  private readonly avrAs: WasmTool;
  private readonly avrLd: WasmTool;
  private readonly headerInputs: { path: string; bytes: Uint8Array }[];

  constructor(
    tools: AvrToolFactories,
    private readonly sdk: AvrSdk,
    readonly variant: 'threaded' | 'singlethread' = 'singlethread',
    private readonly recipe: AvrTargetRecipe = ATMEGA328P_RECIPE,
  ) {
    this.id = recipe.id;
    this.cc1plus = new WasmTool(tools.cc1plus, 'cc1plus');
    this.cc1 = tools.cc1 ? new WasmTool(tools.cc1, 'cc1') : null;
    this.avrAs = new WasmTool(tools.avrAs, 'avr-as');
    this.avrLd = new WasmTool(tools.avrLd, 'avr-ld');
    // Pre-flatten the SDK headers into MEMFS input entries (written per compile).
    this.headerInputs = sdk.headerMounts.flatMap((m) =>
      m.files.map((f) => ({ path: `${m.mount}/${f.path}`, bytes: f.bytes })),
    );
  }

  /** cc1plus include flags derived from the SDK header mounts. */
  private includeFlags(): string[] {
    const flags: string[] = [];
    for (const m of this.sdk.headerMounts) {
      // Convention: dirs named .../core, .../variant are -I; system trees -isystem.
      if (m.mount.endsWith('/core') || m.mount.endsWith('/variant')) flags.push('-I', m.mount);
      else flags.push('-isystem', m.mount);
    }
    return flags;
  }

  async compile(input: CompileInput): Promise<CompileOutput> {
    const isC = input.language === 'c';
    if (isC && !this.cc1) {
      return {
        object: new Uint8Array(0),
        dep: '',
        diagnostics: [diag('error', 'C source needs the cc1 tool (not provided)')],
      };
    }
    const src = isC ? '/in.c' : '/in.cpp';
    // Shared base: standard Arduino AVR defines (older avr-libc gates UINT32_MAX etc.
    // behind the limit/constant macros — many libraries use them).
    const base = [
      '-quiet',
      ...this.recipe.deviceDefines,
      '-D__STDC_LIMIT_MACROS',
      '-D__STDC_CONSTANT_MACROS',
      ...this.includeFlags(),
      `-mmcu=${this.recipe.mmcu}`,
    ];
    // C++ adds the language std + the no-exceptions/rtti flags Arduino uses; C uses
    // gnu11 and omits the C++-only flags (cc1 rejects them).
    const langFlags = isC
      ? ['-std=gnu11']
      : ['-std=gnu++11', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics'];
    const args = [
      ...base,
      ...langFlags,
      ...input.flags.filter((f) => !f.startsWith('-mmcu')),
      src,
      '-o',
      '/out.s',
    ];

    const compileRun = await (isC ? this.cc1! : this.cc1plus).run({
      args,
      inputs: [
        { path: src, bytes: input.sourceBytes },
        ...this.headerInputs,
        ...(input.extraHeaders ?? []),
      ],
      outputs: ['/out.s'],
    });
    const diagnostics = parseDiagnostics(compileRun.stderr);
    const asm = compileRun.outputs.get('/out.s');
    if (!asm || compileRun.exitCode !== 0) {
      if (!diagnostics.some((d) => d.severity === 'error')) {
        diagnostics.push(
          diag('error', `${isC ? 'cc1' : 'cc1plus'} failed (exit ${compileRun.exitCode})`),
        );
      }
      return { object: new Uint8Array(0), dep: '', diagnostics };
    }

    const asmRun = await this.avrAs.run({
      args: [`-mmcu=${this.recipe.mmcu}`, '-o', '/out.o', '/in.s'],
      inputs: [{ path: '/in.s', bytes: asm }],
      outputs: ['/out.o'],
    });
    diagnostics.push(...parseDiagnostics(asmRun.stderr));
    const object = asmRun.outputs.get('/out.o');
    if (!object || asmRun.exitCode !== 0) {
      diagnostics.push(diag('error', `avr-as failed (exit ${asmRun.exitCode})`));
      return { object: new Uint8Array(0), dep: '', diagnostics };
    }

    const dep = `out.o: ${input.sourceKey} ${input.includedHeaderHashes.join(' ')}`.trim();
    return { object, dep, diagnostics };
  }

  async link(input: LinkInput): Promise<LinkOutput> {
    // Objects mounted as /obj0.o, /obj1.o … in stable order (invariant I4).
    const objectInputs = input.objects.map((bytes, i) => ({ path: `/obj${i}.o`, bytes }));
    const objectArgs = objectInputs.map((o) => o.path);
    const libInputs = this.sdk.libs.map((l) => ({ path: `/lib/${l.name}`, bytes: l.bytes }));

    const run = await this.avrLd.run({
      args: [
        '-m',
        this.recipe.mmcu,
        '-T',
        '/avr5.x',
        '-Tdata',
        this.recipe.dataOrigin,
        '--gc-sections',
        '-o',
        '/out.elf',
        '/crt.o',
        ...objectArgs,
        '-L/lib',
        '/core.a',
        '--start-group',
        ...this.recipe.linkLibs.map((l) => `-l${l}`),
        '--end-group',
      ],
      inputs: [
        { path: '/crt.o', bytes: this.sdk.crt },
        { path: '/core.a', bytes: this.sdk.coreA },
        { path: '/avr5.x', bytes: this.sdk.ldscript },
        ...objectInputs,
        ...libInputs,
      ],
      outputs: ['/out.elf'],
    });

    const diagnostics = parseDiagnostics(run.stderr);
    const elf = run.outputs.get('/out.elf');
    if (!elf || run.exitCode !== 0) {
      if (!diagnostics.some((d) => d.severity === 'error')) {
        diagnostics.push(diag('error', `avr-ld failed (exit ${run.exitCode})`));
      }
      return { elf: new Uint8Array(0), map: '', diagnostics };
    }
    return {
      elf,
      map: `linked ${input.objects.length} objects for ${this.recipe.mmcu}`,
      diagnostics,
    };
  }
}
