import { describe, it, expect, beforeEach } from 'vitest';
import { loadToolchain, toolchainInstantiations, resetToolchains } from './loader.js';

describe('toolchain loader (warm singleton)', () => {
  beforeEach(() => resetToolchains());

  it('instantiates once and reuses the warm instance', () => {
    const a = loadToolchain('singlethread');
    const b = loadToolchain('singlethread');
    expect(a).toBe(b);
    expect(toolchainInstantiations()).toBe(1);
  });

  it('separate variants get separate instances', () => {
    loadToolchain('singlethread');
    loadToolchain('threaded');
    expect(toolchainInstantiations()).toBe(2);
  });

  it('many compiles do not re-instantiate (gate 1)', async () => {
    const tc = loadToolchain('singlethread');
    for (let i = 0; i < 20; i++) {
      await tc.compile({
        sourceKey: `sha256:${i}`,
        sourceBytes: new TextEncoder().encode(`int v${i};`),
        target: 'avr-atmega328p',
        flags: ['-Os'],
        includedHeaderHashes: [],
      });
    }
    expect(toolchainInstantiations()).toBe(1);
  });
});
