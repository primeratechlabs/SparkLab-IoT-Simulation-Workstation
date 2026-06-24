import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  parseIndex,
  searchRegistry,
  loadRegistry,
  downloadLibrary,
  type RegistryLib,
} from './library-registry';
import { blobOf } from './unzip';

describe('library-registry — pure logic', () => {
  it('compareVersions orders dotted versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0);
  });

  it('parseIndex keeps one entry per library (latest version)', () => {
    const libs = parseIndex({
      libraries: [
        { name: 'DHT', version: '1.3.0', url: 'u130' },
        { name: 'DHT', version: '1.4.6', url: 'u146' },
        { name: 'Servo', version: '1.2.1', url: 'us' },
        { name: 'Bad', version: '1.0.0', url: '' }, // no url → dropped
      ],
    });
    expect(libs.map((l) => `${l.name}@${l.version}`)).toEqual(['DHT@1.4.6', 'Servo@1.2.1']);
    expect(libs.find((l) => l.name === 'DHT')!.url).toBe('u146');
  });

  it('searchRegistry matches name + description, ranks exact/prefix first', () => {
    const libs: RegistryLib[] = [
      {
        name: 'OneWire',
        version: '1',
        author: '',
        sentence: 'bus',
        architectures: [],
        url: '',
        size: 0,
      },
      {
        name: 'DHT sensor library',
        version: '1',
        author: '',
        sentence: 'temperature',
        architectures: [],
        url: '',
        size: 0,
      },
      {
        name: 'DHT',
        version: '1',
        author: '',
        sentence: 'humidity',
        architectures: [],
        url: '',
        size: 0,
      },
    ];
    const hits = searchRegistry(libs, 'dht');
    expect(hits[0]!.name).toBe('DHT'); // exact match ranks first
    expect(hits.map((h) => h.name)).toContain('DHT sensor library');
    expect(searchRegistry(libs, '')).toEqual([]); // empty query → no results
  });
});

describe('library-registry — fetch (injected, gzip-inflated)', () => {
  async function gzip(s: string): Promise<Uint8Array> {
    const cs = new CompressionStream('gzip');
    return new Uint8Array(
      await new Response(
        blobOf(new TextEncoder().encode(s)).stream().pipeThrough(cs),
      ).arrayBuffer(),
    );
  }

  it('loadRegistry fetches + gunzips + parses the index', async () => {
    const gz = await gzip(
      JSON.stringify({ libraries: [{ name: 'Foo', version: '2.0.0', url: 'https://x/foo.zip' }] }),
    );
    const fetchImpl = (async () =>
      new Response(blobOf(gz).stream(), { status: 200 })) as typeof fetch;
    const libs = await loadRegistry(fetchImpl);
    expect(libs.find((l) => l.name === 'Foo')?.version).toBe('2.0.0');
  });

  it('downloadLibrary returns the zip bytes from an allowed host', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = (async () => new Response(blobOf(bytes), { status: 200 })) as typeof fetch;
    const out = await downloadLibrary(
      {
        name: 'Foo',
        version: '1',
        author: '',
        sentence: '',
        architectures: [],
        url: 'https://downloads.arduino.cc/libraries/foo.zip',
        size: 4,
      },
      fetchImpl,
    );
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('downloadLibrary rejects a non-HTTPS or untrusted-host URL (AUD-017)', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), { status: 200 })) as typeof fetch;
    const lib = (url: string): RegistryLib => ({
      name: 'X',
      version: '1',
      author: '',
      sentence: '',
      architectures: [],
      url,
      size: 1,
    });
    await expect(
      downloadLibrary(lib('http://downloads.arduino.cc/x.zip'), fetchImpl),
    ).rejects.toThrow(/HTTPS/);
    await expect(downloadLibrary(lib('https://evil.example/x.zip'), fetchImpl)).rejects.toThrow(
      /host không tin cậy/,
    );
  });
});
