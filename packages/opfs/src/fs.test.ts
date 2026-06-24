import { describe, it, expect, afterEach } from 'vitest';
import { assertSafePath, openFs } from './fs.js';

describe('assertSafePath — backend-parity path safety (AUD-012)', () => {
  it('accepts normal relative paths and the root', () => {
    for (const p of ['', 'a', 'a/b/c', 'packs/toolchains/x@1.0.0/bin/tool', 'a//b']) {
      expect(() => assertSafePath(p)).not.toThrow();
    }
  });

  it('rejects parent-traversal segments anywhere in the path', () => {
    for (const p of ['..', '../x', 'a/../b', 'a/b/..', 'a/../../etc']) {
      expect(() => assertSafePath(p)).toThrow(/traversal/);
    }
  });

  it('rejects current-dir segments (normalization parity with OPFS)', () => {
    for (const p of ['.', './x', 'a/./b']) {
      expect(() => assertSafePath(p)).toThrow(/traversal/);
    }
  });

  it('rejects backslashes and control characters', () => {
    expect(() => assertSafePath('a\\b')).toThrow(/control char or backslash/);
    expect(() => assertSafePath('a\x00b')).toThrow(/control char or backslash/);
    expect(() => assertSafePath('a\nb')).toThrow(/control char or backslash/);
  });
});

describe('openFs — fallback + failure classification (AUD-012)', () => {
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  afterEach(() => {
    if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav);
    else delete (globalThis as Record<string, unknown>).navigator;
    if (savedIdb) Object.defineProperty(globalThis, 'indexedDB', savedIdb);
    else delete (globalThis as Record<string, unknown>).indexedDB;
  });

  function setNavigatorGetDirectory(fn: (() => Promise<unknown>) | undefined): void {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: fn ? { storage: { getDirectory: fn } } : {},
    });
  }

  /** Minimal indexedDB whose open() resolves a stub db (openFs only needs the handle, not real I/O). */
  function fakeIndexedDb(): void {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open() {
          const req: Record<string, unknown> = {
            result: { objectStoreNames: { contains: () => true } },
          };
          queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
          return req;
        },
      },
    });
  }

  it('falls back to IndexedDB when getDirectory exists but throws (permission/transient)', async () => {
    setNavigatorGetDirectory(() => Promise.reject(new Error('NotAllowedError')));
    fakeIndexedDb();
    const fs = await openFs();
    expect(fs.backend).toBe('indexeddb');
  });

  it('throws with BOTH reasons when OPFS fails and there is no IndexedDB', async () => {
    setNavigatorGetDirectory(() => Promise.reject(new Error('NotAllowedError')));
    delete (globalThis as Record<string, unknown>).indexedDB;
    await expect(openFs()).rejects.toThrow(/OPFS failed.*no IndexedDB/);
  });

  it('throws cleanly when neither OPFS nor IndexedDB is available', async () => {
    setNavigatorGetDirectory(undefined);
    delete (globalThis as Record<string, unknown>).indexedDB;
    await expect(openFs()).rejects.toThrow(/no persistent storage backend/);
  });
});
