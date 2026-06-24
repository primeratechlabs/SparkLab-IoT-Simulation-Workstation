import { describe, it, expect } from 'vitest';
import { packInstallPath, packDirFor, objectPath, firmwarePath, bootstrapDirs } from './layout.js';

describe('layout (§10)', () => {
  it('maps pack types to directories', () => {
    expect(packDirFor('toolchain')).toBe('packs/toolchains');
    expect(packDirFor('sdk')).toBe('packs/sdk');
    expect(packDirFor('board')).toBe('packs/boards');
    expect(() => packDirFor('bogus')).toThrow();
  });

  it('builds install paths as <dir>/<name>@<version>', () => {
    expect(packInstallPath('toolchain', 'avr-gcc-wasm', '12.2')).toBe(
      'packs/toolchains/avr-gcc-wasm@12.2',
    );
  });

  it('content-addresses build artifacts', () => {
    expect(objectPath('abc123')).toBe('build/objects/abc123.o');
    expect(firmwarePath('def456', 'hex')).toBe('build/firmware/def456.hex');
  });

  it('lists unique bootstrap directories', () => {
    const dirs = bootstrapDirs();
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs).toContain('db');
    expect(dirs).toContain('build/objects');
  });
});
