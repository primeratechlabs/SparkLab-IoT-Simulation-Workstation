import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

const setUserLibraries = vi.fn();
vi.mock('../lib/build-client', () => ({ getBuild: () => ({ setUserLibraries }) }));

import { useUserLibraries } from './useUserLibraries';

/** A minimal STORED (uncompressed) .zip — enough to exercise the upload→parse→push path. */
function storedZip(files: { name: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const crc32 = (b: Uint8Array): number => {
    let c = ~0;
    for (let i = 0; i < b.length; i++) {
      c ^= b[i]!;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let off = 0;
  for (const f of files) {
    const nb = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nb.length, true);
    const local = new Uint8Array(30 + nb.length + data.length);
    local.set(new Uint8Array(lh.buffer));
    local.set(nb, 30);
    local.set(data, 30 + nb.length);
    locals.push(local);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nb.length, true);
    ch.setUint32(42, off, true);
    const central = new Uint8Array(46 + nb.length);
    central.set(new Uint8Array(ch.buffer));
    central.set(nb, 46);
    centrals.push(central);
    off += local.length;
  }
  const cd = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cd, true);
  eocd.setUint32(16, off, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function fileFrom(bytes: Uint8Array, name: string): File {
  return {
    name,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as File;
}

function withComposable() {
  let api!: ReturnType<typeof useUserLibraries>;
  const Comp = defineComponent({
    setup() {
      api = useUserLibraries();
      return () => null;
    },
  });
  mount(Comp);
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('useUserLibraries', () => {
  it('addZip parses a library, persists it, and pushes it to the build worker', async () => {
    const api = withComposable();
    const zip = storedZip([
      { name: 'Cool/Cool.h', content: '#pragma once\nint cool();\n' },
      { name: 'Cool/Cool.cpp', content: 'int cool(){ return 1; }\n' },
    ]);
    const res = await api.addZip(fileFrom(zip, 'Cool.zip'));
    expect(res).toEqual({ ok: true, name: 'Cool' });
    expect(api.libraries.value.map((l) => l.name)).toEqual(['Cool']);
    expect(api.libraries.value[0]!.provides).toEqual(['Cool.h']);
    expect(setUserLibraries).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'Cool' })]);
    expect(JSON.parse(localStorage.getItem('sparklab:user-libraries')!)[0].name).toBe('Cool');
  });

  it('rejects a .zip with no code library', async () => {
    const api = withComposable();
    const zip = storedZip([{ name: 'docs/readme.txt', content: 'hi' }]);
    const res = await api.addZip(fileFrom(zip, 'docs.zip'));
    expect(res.ok).toBe(false);
    expect(api.libraries.value).toHaveLength(0);
  });

  it('remove drops the library and pushes the new (empty) set', async () => {
    const api = withComposable();
    await api.addZip(fileFrom(storedZip([{ name: 'A/A.h', content: 'void a();\n' }]), 'A.zip'));
    await api.remove('A');
    expect(api.libraries.value).toHaveLength(0);
    expect(setUserLibraries).toHaveBeenLastCalledWith([]);
  });
});
