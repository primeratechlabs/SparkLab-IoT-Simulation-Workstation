/**
 * Deterministic stub toolchain for Stage 1.
 *
 * It does NOT run a real compiler — it produces a deterministic "object" that is
 * a pure function of (source, target, flags, header hashes), so the orchestrator,
 * content-addressed cache, reproducibility checks, dependency scanning and linking
 * can all be exercised end-to-end before the real avr-gcc-wasm pack exists. The
 * Toolchain interface is identical to what the real toolchain will implement.
 */

import type { Diagnostic } from '@sparklab/shared';
import type { CompileInput, CompileOutput, LinkInput, LinkOutput, Toolchain } from './types.js';
import { writeElf32, EM_AVR, EM_RISCV, EM_XTENSA, ET_EXEC } from './elf.js';

const OBJ_MAGIC = 'SLOBJ1\n';
const encoder = new TextEncoder();

export function machineForTarget(target: string): number {
  if (target.startsWith('avr')) return EM_AVR;
  if (target.startsWith('riscv')) return EM_RISCV;
  if (target.startsWith('xtensa')) return EM_XTENSA;
  return EM_AVR;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Detect trivial diagnostics in source so error paths can be tested deterministically. */
function scanDiagnostics(source: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*#error\s+(.*)$/);
    if (m) {
      diags.push({ severity: 'error', file: '<source>', line: i + 1, message: m[1]!.trim() });
    }
  });
  return diags;
}

export class StubToolchain implements Toolchain {
  readonly id = 'stub-cc@1';
  private static _instantiations = 0;

  constructor(readonly variant: 'threaded' | 'singlethread' = 'singlethread') {
    StubToolchain._instantiations += 1;
  }

  /** How many times the (heavy) toolchain has been instantiated — gate: warm reuse. */
  static get instantiations(): number {
    return StubToolchain._instantiations;
  }
  static resetInstantiations(): void {
    StubToolchain._instantiations = 0;
  }

  async compile(input: CompileInput): Promise<CompileOutput> {
    const source = new TextDecoder().decode(input.sourceBytes);
    const diagnostics = scanDiagnostics(source);

    // Deterministic object container: header + normalized inputs + source bytes.
    const header = encoder.encode(
      `${OBJ_MAGIC}id=${this.id}\n` +
        `target=${input.target}\n` +
        `flags=${input.flags.join(' ')}\n` +
        `headers=${input.includedHeaderHashes.join(',')}\n` +
        `source:\n`,
    );
    const object = concatBytes([header, input.sourceBytes]);

    const dep = `out.o: ${input.sourceKey} ${input.includedHeaderHashes.join(' ')}`.trim();
    return { object, dep, diagnostics };
  }

  async link(input: LinkInput): Promise<LinkOutput> {
    const errors = input.objects.filter((o) => !startsWith(o, OBJ_MAGIC));
    const diagnostics: Diagnostic[] = errors.length
      ? [{ severity: 'error', file: '<link>', line: 0, message: 'invalid object in link set' }]
      : [];

    // Concatenate object payloads (stable order) as the .text section of a valid ELF.
    const payload = concatBytes(input.objects);
    const elf = writeElf32(payload, { machine: machineForTarget(input.target), type: ET_EXEC });
    const map = `link target=${input.target}\nobjects=${input.objects.length}\ntext_size=${payload.length}\n`;
    return { elf, map, diagnostics };
  }
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  const p = encoder.encode(prefix);
  if (bytes.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (bytes[i] !== p[i]) return false;
  return true;
}
