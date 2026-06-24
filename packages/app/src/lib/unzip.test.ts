import { describe, it, expect } from 'vitest';
import { unzip, blobOf } from './unzip';

/** Build a minimal but valid ZIP in-memory (one method per entry) so the reader is tested without a
 *  fixture file. Uses CompressionStream for the deflate entry (the inverse of the reader's path). */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const stream = blobOf(data).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

interface FileSpec {
  name: string;
  content: string;
  method: 0 | 8;
}

async function makeZip(files: FileSpec[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const raw = enc.encode(f.content);
    const comp = f.method === 8 ? await deflateRaw(raw) : raw;
    const crc = crc32(raw);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(8, f.method, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameB.length, true);
    const local = new Uint8Array(30 + nameB.length + comp.length);
    local.set(new Uint8Array(lh.buffer), 0);
    local.set(nameB, 30);
    local.set(comp, 30 + nameB.length);
    locals.push(local);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(10, f.method, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    const central = new Uint8Array(46 + nameB.length);
    central.set(new Uint8Array(ch.buffer), 0);
    central.set(nameB, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('unzip — minimal ZIP reader (no dependency)', () => {
  it('extracts stored + deflated entries with correct paths and content', async () => {
    const zip = await makeZip([
      { name: 'MyLib/MyLib.h', content: '#pragma once\nint answer();\n', method: 0 },
      { name: 'MyLib/MyLib.cpp', content: 'int answer(){ return 42; }\n'.repeat(20), method: 8 },
      { name: 'MyLib/', content: '', method: 0 }, // a directory entry → skipped
    ]);
    const entries = await unzip(zip);
    const byName = Object.fromEntries(
      entries.map((e) => [e.name, new TextDecoder().decode(e.bytes)]),
    );
    expect(Object.keys(byName).sort()).toEqual(['MyLib/MyLib.cpp', 'MyLib/MyLib.h']);
    expect(byName['MyLib/MyLib.h']).toContain('int answer();');
    expect(byName['MyLib/MyLib.cpp']!.startsWith('int answer(){ return 42; }')).toBe(true);
  });

  it('rejects a non-zip buffer', async () => {
    await expect(unzip(new TextEncoder().encode('not a zip'))).rejects.toThrow(/\.zip/);
  });
});
