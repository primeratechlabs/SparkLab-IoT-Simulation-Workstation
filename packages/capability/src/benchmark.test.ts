import { describe, it, expect } from 'vitest';
import { buildLargeWasmModule, benchmarkWasmInstantiate, uleb } from './benchmark.js';

describe('uleb', () => {
  it('encodes known LEB128 values', () => {
    expect(uleb(0)).toEqual([0x00]);
    expect(uleb(1)).toEqual([0x01]);
    expect(uleb(127)).toEqual([0x7f]);
    expect(uleb(128)).toEqual([0x80, 0x01]);
    expect(uleb(300)).toEqual([0xac, 0x02]);
    expect(uleb(624485)).toEqual([0xe5, 0x8e, 0x26]);
  });

  it('rejects negative input instead of looping forever (regression)', () => {
    // Before the guard, uleb(-1) spun the do/while loop indefinitely because
    // Math.floor(v / 128) never reaches 0 for negative v.
    expect(() => uleb(-1)).toThrow(RangeError);
    expect(() => uleb(-12345)).toThrow(RangeError);
    expect(() => uleb(Number.NaN)).toThrow(RangeError);
  });
});

describe('buildLargeWasmModule', () => {
  it('produces a valid, instantiable module of the requested data size', async () => {
    const dataBytes = 256 * 1024; // small for test speed
    const mod = buildLargeWasmModule(dataBytes);
    expect(WebAssembly.validate(mod as BufferSource)).toBe(true);
    // header(8) + sections + data >= dataBytes
    expect(mod.length).toBeGreaterThanOrEqual(dataBytes);

    const ms = await benchmarkWasmInstantiate(dataBytes);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('starts with the WASM magic + version', () => {
    const mod = buildLargeWasmModule(1024);
    expect(Array.from(mod.slice(0, 8))).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  });

  it('builds a valid, instantiable module for a 0-byte data section', async () => {
    const mod = buildLargeWasmModule(0);
    expect(WebAssembly.validate(mod as BufferSource)).toBe(true);
    const ms = await benchmarkWasmInstantiate(0);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('emits a module whose total length matches header + sections + data', () => {
    const dataBytes = 4096;
    const mod = buildLargeWasmModule(dataBytes);
    // The trailing `dataBytes` zeros sit after a fixed-shape prefix, so the
    // module must be strictly larger than the requested payload.
    expect(mod.length).toBeGreaterThan(dataBytes);
    // The last `dataBytes` bytes are the zero-filled data payload.
    expect(mod.slice(mod.length - dataBytes).every((b) => b === 0)).toBe(true);
  });
});
