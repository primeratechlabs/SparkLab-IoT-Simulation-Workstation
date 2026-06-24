import { describe, it, expect } from 'vitest';
import { MemoryFs, MemoryBuildIndex } from '@sparklab/opfs';
import type { Sha256 } from '@sparklab/shared';
import type {
  Toolchain,
  CompileInput,
  CompileOutput,
  LinkInput,
  LinkOutput,
} from '@sparklab/toolchain-loader';
import { ObjectCache } from './ccache.js';
import { scheduleBuild } from './scheduler.js';
import type { BuildUnitPlan } from './graph.js';

const enc = new TextEncoder();

/**
 * Toolchain stub: compiles every unit to a deterministic object (sourceBytes echoed)
 * EXCEPT sources whose text is in `failOn`, which emit an error diagnostic and no
 * usable object — exercising the failed-unit accounting path.
 */
function fakeToolchain(failOn: Set<string>): Toolchain {
  return {
    id: 'fake-cc@1',
    variant: 'singlethread',
    async compile(input: CompileInput): Promise<CompileOutput> {
      const text = new TextDecoder().decode(input.sourceBytes);
      if (failOn.has(text)) {
        return {
          object: new Uint8Array(),
          dep: '',
          diagnostics: [{ severity: 'error', file: 'unit.cpp', line: 1, message: `bad: ${text}` }],
        };
      }
      return { object: input.sourceBytes, dep: '', diagnostics: [] };
    },
    async link(_input: LinkInput): Promise<LinkOutput> {
      throw new Error('not used in scheduler tests');
    },
  };
}

let unitCounter = 0;
function plan(source: string): BuildUnitPlan {
  const id = `u${unitCounter++}`;
  const sourceKey = `sha256:${id.padStart(4, '0')}` as Sha256;
  return {
    unitId: id,
    sourceKey,
    sourceBytes: enc.encode(source),
    target: 'avr-atmega328p',
    flags: ['-Os'],
    includedHeaderHashes: [],
    keyInput: {
      compilerId: 'fake-cc@1',
      compilerFlags: ['-Os'],
      targetTriple: 'avr-atmega328p',
      sourceHash: sourceKey,
      includedHeaderHashes: [],
      sdkPackHash: 'sha256:sdk' as Sha256,
      libraryPackHash: 'sha256:lib' as Sha256,
    },
  };
}

function freshCache() {
  return new ObjectCache(new MemoryFs(), new MemoryBuildIndex());
}

describe('scheduleBuild accounting', () => {
  it('keeps objectKeys 1:1 with compiled+reused and records failures separately', async () => {
    const okA = plan('int a(){return 1;}');
    const bad = plan('#error nope');
    const okB = plan('int b(){return 2;}');
    const toolchain = fakeToolchain(new Set(['#error nope']));

    const res = await scheduleBuild({
      plans: [okA, bad, okB],
      cache: freshCache(),
      toolchain,
    });

    expect(res.fromFirmwareCache).toBe(false);
    expect(res.compiledUnitIds.sort()).toEqual([okA.unitId, okB.unitId].sort());
    expect(res.failedUnitIds).toEqual([bad.unitId]);
    expect(res.reusedUnitIds).toHaveLength(0);
    // objectKeys must NOT include the failed unit — one key per compiled/reused unit.
    expect(res.objectKeys).toHaveLength(res.compiledUnitIds.length + res.reusedUnitIds.length);
    // Exhaustive accounting: every plan is in exactly one bucket.
    const accounted =
      res.compiledUnitIds.length + res.reusedUnitIds.length + res.failedUnitIds.length;
    expect(accounted).toBe(3);
    expect(res.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('reuses a cached object on the second run and never reports it as failed', async () => {
    const cache = freshCache();
    const okA = plan('int a(){return 1;}');
    const toolchain = fakeToolchain(new Set());

    const first = await scheduleBuild({ plans: [okA], cache, toolchain });
    expect(first.compiledUnitIds).toEqual([okA.unitId]);
    expect(first.failedUnitIds).toHaveLength(0);

    const second = await scheduleBuild({ plans: [okA], cache, toolchain });
    expect(second.compiledUnitIds).toHaveLength(0);
    expect(second.reusedUnitIds).toEqual([okA.unitId]);
    expect(second.failedUnitIds).toHaveLength(0);
    expect(second.objectKeys).toEqual(first.objectKeys);
  });
});
