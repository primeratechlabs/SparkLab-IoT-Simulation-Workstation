import { describe, it, expect, beforeAll } from 'vitest';
import { init as zstdInit, compress as zstdCompress } from '@bokuweb/zstd-wasm';
import { sha256, type PackManifestBase } from '@sparklab/shared';
import type { VirtualFs, FileData } from '@sparklab/opfs';
import type {
  BuildIndex,
  InstalledPackRecord,
  ObjectCacheRecord,
  FirmwareCacheRecord,
  CapabilitySnapshot,
} from '@sparklab/opfs';
import { generateSigningKeyPair, signManifest, canonicalManifestBytes } from './verify.js';
import { manifestPinSet } from './pinning.js';
import { decompressZstd } from './decompress.js';
import { installPack } from './install.js';
import { evictPack } from './evict.js';
import { getStorageHealth } from './health.js';
import type { PackSource } from './source.js';

// ── In-memory test doubles (Node has no OPFS/IndexedDB) ─────────────────────

const enc = new TextEncoder();
function bytesOf(d: FileData): Uint8Array {
  if (typeof d === 'string') return enc.encode(d);
  return d instanceof ArrayBuffer ? new Uint8Array(d) : d;
}

class MemoryFs implements VirtualFs {
  readonly backend = 'opfs' as const;
  files = new Map<string, Uint8Array>();
  async mkdirp(): Promise<void> {}
  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    const prefix = `${path}/`;
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
  async writeFile(path: string, data: FileData): Promise<void> {
    this.files.set(path, bytesOf(data));
  }
  async readFile(path: string): Promise<Uint8Array> {
    const v = this.files.get(path);
    if (!v) throw new Error(`not found ${path}`);
    return v;
  }
  async readFileText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }
  async list(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}/`;
    const out = new Set<string>();
    for (const k of this.files.keys())
      if (k.startsWith(prefix)) out.add(k.slice(prefix.length).split('/')[0]!);
    return [...out];
  }
  async remove(path: string): Promise<void> {
    for (const k of [...this.files.keys()])
      if (k === path || k.startsWith(`${path}/`)) this.files.delete(k);
  }
  async size(path: string): Promise<number> {
    return (await this.readFile(path)).length;
  }
}

class MemoryIndex implements BuildIndex {
  readonly backend = 'indexeddb' as const;
  packs = new Map<string, InstalledPackRecord>();
  async init(): Promise<void> {}
  async recordInstalledPack(r: InstalledPackRecord): Promise<void> {
    this.packs.set(`${r.name}@${r.version}`, r);
  }
  async listInstalledPacks(): Promise<InstalledPackRecord[]> {
    return [...this.packs.values()];
  }
  async getInstalledPack(name: string, version?: string): Promise<InstalledPackRecord | null> {
    if (version) return this.packs.get(`${name}@${version}`) ?? null;
    return [...this.packs.values()].find((p) => p.name === name) ?? null;
  }
  async removeInstalledPack(name: string, version: string): Promise<void> {
    this.packs.delete(`${name}@${version}`);
  }
  async putObject(_k: string, _r: ObjectCacheRecord): Promise<void> {}
  async getObject(): Promise<ObjectCacheRecord | null> {
    return null;
  }
  async touchObject(): Promise<void> {}
  async listObjects(): Promise<{ objectKey: string; sizeBytes: number; lastUsedAt: number }[]> {
    return [];
  }
  async deleteObject(): Promise<void> {}
  async putFirmware(_k: string, _r: FirmwareCacheRecord): Promise<void> {}
  async getFirmware(): Promise<FirmwareCacheRecord | null> {
    return null;
  }
  async setSourceHash(): Promise<void> {}
  async getSourceHash(): Promise<string | null> {
    return null;
  }
  async recordCapability(): Promise<void> {}
  async latestCapability(): Promise<CapabilitySnapshot | null> {
    return null;
  }
  async putProjectJson(): Promise<void> {}
  async getProjectJson(): Promise<string | null> {
    return null;
  }
  async close(): Promise<void> {}
}

class MemoryPackSource implements PackSource {
  constructor(
    private readonly manifestObj: PackManifestBase,
    private readonly compressedFiles: Map<string, Uint8Array>,
  ) {}
  fetchCount = 0;
  manifestCount = 0;
  async manifest(): Promise<PackManifestBase> {
    this.manifestCount++;
    return this.manifestObj;
  }
  async file(path: string): Promise<Uint8Array> {
    this.fetchCount++;
    const v = this.compressedFiles.get(path);
    if (!v) throw new Error(`no such file ${path}`);
    return v;
  }
}

// ── Fixture builder ──────────────────────────────────────────────────────

async function buildSignedPack(privateKey: CryptoKey) {
  // Two files; one moderately large to exercise streaming-ish paths.
  const fileContents: Record<string, Uint8Array> = {
    'bin/tool': new Uint8Array(64 * 1024).map((_, i) => i & 0xff),
    'meta.txt': enc.encode('sparklab sample toolchain pack'),
  };
  const files = [];
  const compressed = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(fileContents)) {
    files.push({ path, sha256: await sha256(bytes) });
    compressed.set(path, new Uint8Array(zstdCompress(bytes, 3)));
  }
  const unsigned: PackManifestBase = {
    packType: 'toolchain',
    name: 'sample-toolchain',
    version: '1.0.0',
    files,
    signature: 'ed25519:',
  };
  const signature = await signManifest(unsigned, privateKey);
  return { manifest: { ...unsigned, signature }, compressed, fileContents };
}

describe('pack install pipeline', () => {
  beforeAll(async () => {
    await zstdInit();
  });

  it('zstd-wasm output decompresses with fzstd (interop)', () => {
    const original = enc.encode('round-trip me '.repeat(1000));
    const z = new Uint8Array(zstdCompress(original, 3));
    expect(Array.from(decompressZstd(z))).toEqual(Array.from(original));
  });

  it('rejects a validly-signed pack that is not pinned for this app version (Stage 7)', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(keys.privateKey);
    const manifestHash = await sha256(canonicalManifestBytes(manifest));

    // pinned → installs even though the same key + manifest
    const ok = await installPack({
      source: new MemoryPackSource(manifest, compressed),
      fs: new MemoryFs(),
      index: new MemoryIndex(),
      trustedPublicKeys: [keys.publicKey],
      manifestPins: manifestPinSet('app-1.0.0', [manifestHash]),
    });
    expect(ok.name).toBe('sample-toolchain');

    // not pinned → rejected, despite a valid signature
    await expect(
      installPack({
        source: new MemoryPackSource(manifest, compressed),
        fs: new MemoryFs(),
        index: new MemoryIndex(),
        trustedPublicKeys: [keys.publicKey],
        manifestPins: manifestPinSet('app-1.0.0', ['sha256:not-this-pack']),
      }),
    ).rejects.toThrow(/not pinned/);
  });

  it('installs a signed pack, verifies hashes, and is idempotent on reuse', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed, fileContents } = await buildSignedPack(keys.privateKey);
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, compressed);

    const r1 = await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] });
    expect(r1.reused).toBe(false);
    expect(r1.installPath).toBe('packs/toolchains/sample-toolchain@1.0.0');
    expect(source.fetchCount).toBe(2);
    // Files written with correct decompressed content.
    const tool = await fs.readFile(`${r1.installPath}/bin/tool`);
    expect(Array.from(tool)).toEqual(Array.from(fileContents['bin/tool']!));

    // Second install reuses — no additional file fetches.
    const r2 = await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] });
    expect(r2.reused).toBe(true);
    expect(source.fetchCount).toBe(2);
  });

  it('knownPack fast-path reuses with ZERO fetches (reload gate)', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(keys.privateKey);
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, compressed);
    const knownPack = { packType: 'toolchain', name: 'sample-toolchain', version: '1.0.0' };

    await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey], knownPack });
    const afterInstallFetches = source.fetchCount;
    const afterInstallManifests = source.manifestCount;

    // Simulate reload: same fs+index persist; install again with knownPack.
    const r = await installPack({
      source,
      fs,
      index,
      trustedPublicKeys: [keys.publicKey],
      knownPack,
    });
    expect(r.reused).toBe(true);
    expect(source.fetchCount).toBe(afterInstallFetches); // no new file fetches
    expect(source.manifestCount).toBe(afterInstallManifests); // not even the manifest
  });

  it('does not reuse a known pack when a payload file is missing', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed, fileContents } = await buildSignedPack(keys.privateKey);
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, compressed);
    const knownPack = { packType: 'toolchain', name: 'sample-toolchain', version: '1.0.0' };

    const first = await installPack({
      source,
      fs,
      index,
      trustedPublicKeys: [keys.publicKey],
      knownPack,
    });
    await fs.remove(`${first.installPath}/bin/tool`);
    const manifestsBefore = source.manifestCount;
    const fetchesBefore = source.fetchCount;

    const repaired = await installPack({
      source,
      fs,
      index,
      trustedPublicKeys: [keys.publicKey],
      knownPack,
    });

    expect(repaired.reused).toBe(false);
    expect(source.manifestCount).toBe(manifestsBefore + 1);
    expect(source.fetchCount).toBe(fetchesBefore + manifest.files.length);
    expect(Array.from(await fs.readFile(`${first.installPath}/bin/tool`))).toEqual(
      Array.from(fileContents['bin/tool']!),
    );
  });

  it('records the canonical manifest digest as manifestHash, not the signature (AUD-014)', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(keys.privateKey);
    const index = new MemoryIndex();
    await installPack({
      source: new MemoryPackSource(manifest, compressed),
      fs: new MemoryFs(),
      index,
      trustedPublicKeys: [keys.publicKey],
    });
    const rec = await index.getInstalledPack(manifest.name, manifest.version);
    expect(rec!.manifestHash).toBe(await sha256(canonicalManifestBytes(manifest)));
    expect(rec!.manifestHash).not.toBe(manifest.signature); // the old, conflated value
  });

  it('reinstalls when a local pack file is corrupted and revalidateContent is set (AUD-014)', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed, fileContents } = await buildSignedPack(keys.privateKey);
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, compressed);

    const first = await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] });
    // Corrupt a payload file in place (same path, wrong bytes) — existence is unchanged.
    await fs.writeFile(`${first.installPath}/bin/tool`, Uint8Array.of(9, 9, 9, 9));

    // Default (existence-only) reuse trusts the corrupted file — no re-hash, no fetch.
    const cheap = await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] });
    expect(cheap.reused).toBe(true);

    // With content revalidation, the hash mismatch is detected → reinstall restores correct bytes.
    const fetchesBefore = source.fetchCount;
    const repaired = await installPack({
      source,
      fs,
      index,
      trustedPublicKeys: [keys.publicKey],
      revalidateContent: true,
    });
    expect(repaired.reused).toBe(false);
    expect(source.fetchCount).toBe(fetchesBefore + manifest.files.length);
    expect(Array.from(await fs.readFile(`${first.installPath}/bin/tool`))).toEqual(
      Array.from(fileContents['bin/tool']!),
    );
  });

  it('rejects a pack whose file path escapes the install dir (I6 path traversal)', async () => {
    const keys = await generateSigningKeyPair();
    const evil = '../../../system/pack-registry.json';
    const bytes = enc.encode('pwned');
    const unsigned = {
      packType: 'toolchain' as const,
      name: 'evil',
      version: '1.0.0',
      files: [{ path: evil, sha256: await sha256(bytes) }],
      signature: 'ed25519:',
    };
    const signature = await signManifest(unsigned, keys.privateKey);
    const manifest = { ...unsigned, signature };
    const compressed = new Map([[evil, new Uint8Array(zstdCompress(bytes, 3))]]);
    const fs = new MemoryFs();
    await expect(
      installPack({
        source: new MemoryPackSource(manifest, compressed),
        fs,
        index: new MemoryIndex(),
        trustedPublicKeys: [keys.publicKey],
      }),
    ).rejects.toThrow(/unsafe pack file path/);
    // Nothing written outside the pack dir.
    expect(fs.files.has('system/pack-registry.json')).toBe(false);
  });

  it('rejects a pack signed by an untrusted key (I6)', async () => {
    const realKeys = await generateSigningKeyPair();
    const attacker = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(attacker.privateKey);
    const source = new MemoryPackSource(manifest, compressed);
    await expect(
      installPack({
        source,
        fs: new MemoryFs(),
        index: new MemoryIndex(),
        trustedPublicKeys: [realKeys.publicKey],
      }),
    ).rejects.toThrow(/signature rejected/);
  });

  it('rejects a tampered file whose bytes do not match the manifest hash (I6)', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(keys.privateKey);
    // Corrupt one file's compressed bytes with a different valid zstd payload.
    compressed.set('meta.txt', new Uint8Array(zstdCompress(enc.encode('EVIL'), 3)));
    const source = new MemoryPackSource(manifest, compressed);
    await expect(
      installPack({
        source,
        fs: new MemoryFs(),
        index: new MemoryIndex(),
        trustedPublicKeys: [keys.publicKey],
      }),
    ).rejects.toThrow(/file rejected/);
  });

  it('two concurrent installs download the pack only once (TOCTOU re-check under lock)', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(keys.privateKey);
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, compressed);
    const opts = { source, fs, index, trustedPublicKeys: [keys.publicKey] };

    // Fire both without awaiting between them: both pass the pre-lock idempotency
    // check (nothing installed yet), then serialize through the install lock.
    const [r1, r2] = await Promise.all([installPack(opts), installPack(opts)]);

    // Exactly one of them actually downloaded; the other reused under the lock.
    const reuseCount = [r1, r2].filter((r) => r.reused).length;
    expect(reuseCount).toBe(1);
    // Two files in the fixture → a single install pass fetches each once, no double download.
    expect(source.fetchCount).toBe(manifest.files.length);
  });

  it('installs a pack with an empty file list (manifest.files.length === 0)', async () => {
    const keys = await generateSigningKeyPair();
    const unsigned: PackManifestBase = {
      packType: 'toolchain',
      name: 'empty-pack',
      version: '1.0.0',
      files: [],
      signature: 'ed25519:',
    };
    const signature = await signManifest(unsigned, keys.privateKey);
    const manifest = { ...unsigned, signature };
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, new Map());

    const r = await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] });
    expect(r.reused).toBe(false);
    expect(r.totalBytes).toBe(0);
    expect(source.fetchCount).toBe(0);
    // Manifest persisted; pack recorded and reusable.
    expect(await fs.exists(`${r.installPath}/manifest.json`)).toBe(true);
    const r2 = await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] });
    expect(r2.reused).toBe(true);
  });

  it('a hash failure mid-loop leaves NO partial files on disk (cleanup regression)', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(keys.privateKey);
    // Corrupt the SECOND file so the first writes, then verify throws mid-loop.
    compressed.set('meta.txt', new Uint8Array(zstdCompress(enc.encode('EVIL'), 3)));
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, compressed);

    await expect(
      installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] }),
    ).rejects.toThrow(/file rejected/);

    // The partial install dir must be gone — no half-written file from the first iteration.
    const installPath = 'packs/toolchains/sample-toolchain@1.0.0';
    expect(await fs.exists(installPath)).toBe(false);
    for (const f of manifest.files) {
      expect(fs.files.has(`${installPath}/${f.path}`)).toBe(false);
    }
    // And nothing was recorded in the index.
    expect(await index.getInstalledPack('sample-toolchain', '1.0.0')).toBeNull();
  });

  it('rejects a manifest with a malformed ed25519 signature', async () => {
    const keys = await generateSigningKeyPair();
    const { compressed } = await buildSignedPack(keys.privateKey);
    const unsigned: PackManifestBase = {
      packType: 'toolchain',
      name: 'sample-toolchain',
      version: '1.0.0',
      files: [
        {
          path: 'bin/tool',
          sha256: await sha256(new Uint8Array(64 * 1024).map((_, i) => i & 0xff)),
        },
        { path: 'meta.txt', sha256: await sha256(enc.encode('sparklab sample toolchain pack')) },
      ],
      // Wrong prefix / non-hex garbage — must be rejected, not crash.
      signature: 'ed25519:not-hex-garbage!!',
    };
    const source = new MemoryPackSource(unsigned, compressed);
    await expect(
      installPack({
        source,
        fs: new MemoryFs(),
        index: new MemoryIndex(),
        trustedPublicKeys: [keys.publicKey],
      }),
    ).rejects.toThrow(/signature rejected/);
  });

  it('evicts an installed pack and reports storage health', async () => {
    const keys = await generateSigningKeyPair();
    const { manifest, compressed } = await buildSignedPack(keys.privateKey);
    const fs = new MemoryFs();
    const index = new MemoryIndex();
    const source = new MemoryPackSource(manifest, compressed);

    await installPack({ source, fs, index, trustedPublicKeys: [keys.publicKey] });
    let health = await getStorageHealth(fs, index);
    expect(health.packCount).toBe(1);
    expect(health.missing).toHaveLength(0);

    await evictPack({
      fs,
      index,
      packType: 'toolchain',
      name: 'sample-toolchain',
      version: '1.0.0',
    });
    health = await getStorageHealth(fs, index);
    expect(health.packCount).toBe(0);
  });
});
