import { describe, it, expect } from 'vitest';
import { StubToolchain } from './stub-toolchain.js';
import { isValidElf, parseElf32Header, EM_AVR } from './elf.js';
import type { CompileInput } from './types.js';

const enc = new TextEncoder();

function input(src: string, flags: string[] = ['-Os']): CompileInput {
  return {
    sourceKey: 'sha256:src',
    sourceBytes: enc.encode(src),
    target: 'avr-atmega328p',
    flags,
    includedHeaderHashes: ['sha256:h1'],
  };
}

describe('StubToolchain', () => {
  const tc = new StubToolchain('singlethread');

  it('compile is deterministic for identical input (I4)', async () => {
    const a = await tc.compile(input('int main(){}'));
    const b = await tc.compile(input('int main(){}'));
    expect(Array.from(a.object)).toEqual(Array.from(b.object));
  });

  it('different flags produce a different object', async () => {
    const a = await tc.compile(input('int main(){}', ['-Os']));
    const b = await tc.compile(input('int main(){}', ['-O2']));
    expect(Array.from(a.object)).not.toEqual(Array.from(b.object));
  });

  it('emits a make-style .d dependency line', async () => {
    const out = await tc.compile(input('x'));
    expect(out.dep).toContain('out.o:');
    expect(out.dep).toContain('sha256:h1');
  });

  it('reports #error diagnostics deterministically', async () => {
    const out = await tc.compile(input('#error boom'));
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]!.severity).toBe('error');
    expect(out.diagnostics[0]!.message).toBe('boom');
  });

  it('links multiple objects into a valid AVR ELF', async () => {
    const o1 = (await tc.compile(input('a'))).object;
    const o2 = (await tc.compile(input('b'))).object;
    const linked = await tc.link({ objects: [o1, o2], target: 'avr-atmega328p', flags: [] });
    expect(linked.diagnostics).toHaveLength(0);
    expect(isValidElf(linked.elf)).toBe(true);
    expect(parseElf32Header(linked.elf).machine).toBe(EM_AVR);
  });

  it('link order changes the artifact (link order stability matters)', async () => {
    const o1 = (await tc.compile(input('a'))).object;
    const o2 = (await tc.compile(input('b'))).object;
    const ab = (await tc.link({ objects: [o1, o2], target: 'avr', flags: [] })).elf;
    const ba = (await tc.link({ objects: [o2, o1], target: 'avr', flags: [] })).elf;
    expect(Array.from(ab)).not.toEqual(Array.from(ba));
  });

  it('flags an invalid object in the link set', async () => {
    const bad = enc.encode('not an object');
    const linked = await tc.link({ objects: [bad], target: 'avr', flags: [] });
    expect(linked.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
});
