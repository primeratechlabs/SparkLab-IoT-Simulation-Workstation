/**
 * Real ESP32-C3 (RISC-V) toolchain driven entirely in the browser/WASM (REFERENCE-SPEC
 * Stage 4). Mirrors WasmAvrToolchain: the browser has no fork/exec, so this class IS the
 * driver — it runs clang (compile: C/C++ → rv32imc object, integrated assembler) and
 * ld.lld (link) via WasmTool, mounting the SDK headers/libs/objects into MEMFS per call.
 *
 * clang + lld are the RISCV-target LLVM we cross-built to WASM (clang.mjs / lld.mjs).
 * The compile flag recipe is the one the Stage-4 ABI gate verified end-to-end: clang
 * against the gcc esp newlib + libstdc++ headers (-nobuiltininc + sysroot), so the
 * client-built sketch links cleanly with a clang-built arduino core. Flags themselves
 * live in @sparklab/build-orchestrator (esp32-target.ts) and are passed in, keeping this
 * a pure driver with no recipe coupling.
 */

import type { Diagnostic } from '@sparklab/shared';
import { WasmTool, type EmscriptenModuleFactory, type ToolInput } from './wasm-tool.js';

export interface RiscvToolFactories {
  clang: EmscriptenModuleFactory;
  lld: EmscriptenModuleFactory;
}

export interface RiscvCompileInput {
  /** Full clang argv up to (but excluding) the source + `-o out`: target/march/includes/defines/-c. */
  args: string[];
  /** SDK files (headers, response files) mounted into MEMFS at their referenced paths. */
  sdk: ToolInput[];
  /** Absolute MEMFS path the source is written to (must match what `args` includes). */
  sourcePath: string;
  sourceBytes: Uint8Array | string;
  /** Output object path (default /work/out.o). */
  outPath?: string;
}

export interface RiscvLinkInput {
  /** ld.lld argv (without the leading `-flavor gnu` or trailing `-o out`). */
  args: string[];
  /** Objects, archives, linker scripts mounted into MEMFS at their referenced paths. */
  inputs: ToolInput[];
  /** Output path (default /work/out.elf). Use `--oformat binary` in args for a flat image. */
  outPath?: string;
}

export interface RiscvCompileResult {
  object: Uint8Array;
  diagnostics: Diagnostic[];
  exitCode: number;
}
export interface RiscvLinkResult {
  output: Uint8Array;
  map: string;
  diagnostics: Diagnostic[];
  exitCode: number;
}

function diag(severity: Diagnostic['severity'], message: string): Diagnostic {
  return { severity, file: '<toolchain>', line: 0, message };
}

/** Parse clang/lld stderr into diagnostics (file:line:col: sev: msg, plus bare errors). */
export function parseClangDiagnostics(stderr: string): Diagnostic[] {
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
    } else if (/\b(error|undefined symbol)\b/i.test(line) && line.trim()) {
      out.push(diag('error', line.trim()));
    }
  }
  return out;
}

export class WasmRiscvToolchain {
  readonly id: string;
  private readonly clang: WasmTool;
  private readonly lld: WasmTool;

  constructor(tools: RiscvToolFactories, id = 'esp-clang-wasm@19.1') {
    this.id = id;
    this.clang = new WasmTool(tools.clang, 'clang');
    this.lld = new WasmTool(tools.lld, 'ld.lld');
  }

  /** Compile one translation unit to a RISC-V object (clang's integrated assembler). */
  async compile(input: RiscvCompileInput): Promise<RiscvCompileResult> {
    const out = input.outPath ?? '/out.o'; // root path — WasmTool only mkdirs INPUT dirs
    const run = await this.clang.run({
      args: [...input.args, input.sourcePath, '-o', out],
      inputs: [...input.sdk, { path: input.sourcePath, bytes: input.sourceBytes }],
      outputs: [out],
    });
    const diagnostics = parseClangDiagnostics(run.stderr);
    const object = run.outputs.get(out);
    if (!object || run.exitCode !== 0) {
      if (!diagnostics.some((d) => d.severity === 'error')) {
        diagnostics.push(diag('error', `clang failed (exit ${run.exitCode})`));
      }
      return { object: new Uint8Array(0), diagnostics, exitCode: run.exitCode };
    }
    return { object, diagnostics, exitCode: run.exitCode };
  }

  /** Link objects + archives into an ELF (or a flat binary with `--oformat binary`). */
  async link(input: RiscvLinkInput): Promise<RiscvLinkResult> {
    const out = input.outPath ?? '/out.elf'; // root path — WasmTool only mkdirs INPUT dirs
    const run = await this.lld.run({
      args: ['-flavor', 'gnu', ...input.args, '-o', out],
      inputs: input.inputs,
      outputs: [out],
    });
    const diagnostics = parseClangDiagnostics(run.stderr);
    const output = run.outputs.get(out);
    if (!output || run.exitCode !== 0) {
      if (!diagnostics.some((d) => d.severity === 'error')) {
        diagnostics.push(diag('error', `ld.lld failed (exit ${run.exitCode})`));
      }
      return { output: new Uint8Array(0), map: '', diagnostics, exitCode: run.exitCode };
    }
    return { output, map: `linked → ${output.length} bytes`, diagnostics, exitCode: run.exitCode };
  }
}
