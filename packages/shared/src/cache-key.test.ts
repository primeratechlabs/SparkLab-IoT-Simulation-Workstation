import { describe, it, expect } from 'vitest';
import { objectCacheKey, firmwareCacheKey, ccacheKey } from './cache-key.js';
import type { ObjectCacheKeyInput, FirmwareCacheKeyInput } from './types.js';

const obj: ObjectCacheKeyInput = {
  compilerId: 'avr-gcc-wasm@12.2',
  compilerFlags: ['-Os', '-DF_CPU=16000000L'],
  targetTriple: 'avr-atmega328p',
  sourceHash: 'sha256:aaaa',
  includedHeaderHashes: ['sha256:bbbb', 'sha256:cccc'],
  sdkPackHash: 'sha256:dddd',
  libraryPackHash: 'sha256:eeee',
};

describe('cache-key', () => {
  it('object key is deterministic (I4/I5)', async () => {
    expect(await objectCacheKey(obj)).toBe(await objectCacheKey({ ...obj }));
  });

  it('object key changes when any input changes', async () => {
    const base = await objectCacheKey(obj);
    expect(await objectCacheKey({ ...obj, sourceHash: 'sha256:0000' })).not.toBe(base);
    expect(await objectCacheKey({ ...obj, compilerFlags: ['-O2'] })).not.toBe(base);
  });

  it('header order is significant (link/include order stability matters)', async () => {
    const swapped = { ...obj, includedHeaderHashes: ['sha256:cccc', 'sha256:bbbb'] };
    expect(await objectCacheKey(swapped)).not.toBe(await objectCacheKey(obj));
  });

  it('firmware key is deterministic and order-sensitive on object keys', async () => {
    const fw: FirmwareCacheKeyInput = {
      boardId: 'uno',
      mcuTarget: 'avr-atmega328p',
      frameworkVersion: 'arduino-avr@1.8.6',
      toolchainPackHash: 'sha256:t',
      sdkPackHash: 'sha256:s',
      objectKeys: ['sha256:o1', 'sha256:o2'],
      staticLibraryHashes: ['sha256:l1'],
      linkerScriptHash: 'sha256:ld',
      partitionTableHash: 'sha256:pt',
      imagePackerVersion: 'elf2hex@1',
      simulationProfileId: 'basic',
    };
    expect(await firmwareCacheKey(fw)).toBe(await firmwareCacheKey({ ...fw }));
    const reordered = { ...fw, objectKeys: ['sha256:o2', 'sha256:o1'] };
    expect(await firmwareCacheKey(reordered)).not.toBe(await firmwareCacheKey(fw));
  });

  it('ccache key is deterministic', async () => {
    const input = {
      preprocessedSourceHash: 'sha256:pp',
      compilerId: 'clang@19',
      targetTriple: 'riscv32-esp-elf',
      flags: ['-Os'],
    };
    expect(await ccacheKey(input)).toBe(await ccacheKey({ ...input }));
  });
});
