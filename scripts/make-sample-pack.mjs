/**
 * Fixture generator for the Stage 0 pack-manager gate.
 *
 * Produces, under packages/app/public/fixtures/ (git-ignored, regenerated):
 *   trusted-keys.json                         { publicKeys: [hex] }  (the trusted Ed25519 key)
 *   sample-toolchain/manifest.json            signed by the trusted key
 *   sample-toolchain/files/<path>.zst         zstd-compressed file payloads (>=50MB total)
 *   forged-toolchain/manifest.json            signed by an UNTRUSTED key (rejection test)
 *   forged-toolchain/files/<path>.zst
 *
 * The canonical manifest serialization here MUST match
 * packages/pack-manager/src/verify.ts::canonicalManifestBytes.
 */

import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { init as zstdInit, compress as zstdCompress } from '@bokuweb/zstd-wasm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, '..', 'packages', 'app', 'public', 'fixtures');

const BIG_FILE_BYTES = 50 * 1024 * 1024; // >=50MB to satisfy the gate

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${toHex(new Uint8Array(d))}`;
}

/** Deterministic pseudo-random fill (xorshift32) so the pack is reproducible AND incompressible. */
function pseudoRandomBytes(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 0x12345678;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function canonicalManifestBytes(manifest) {
  const canonical = {
    packType: manifest.packType,
    name: manifest.name,
    version: manifest.version,
    files: [...manifest.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

async function signManifest(unsigned, privateKey) {
  const data = canonicalManifestBytes(unsigned);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data));
  return `ed25519:${toHex(sig)}`;
}

async function buildPack(outDir, files, privateKey, { packType, name, version }) {
  const manifestFiles = [];
  await mkdir(join(outDir, 'files'), { recursive: true });
  for (const { path, bytes } of files) {
    manifestFiles.push({ path, sha256: await sha256Hex(bytes) });
    const compressed = new Uint8Array(zstdCompress(bytes, 3));
    const dest = join(outDir, 'files', `${path}.zst`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, compressed);
  }
  const unsigned = { packType, name, version, files: manifestFiles, signature: 'ed25519:' };
  const signature = await signManifest(unsigned, privateKey);
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify({ ...unsigned, signature }, null, 2),
  );
}

async function main() {
  await zstdInit();
  await rm(OUT_ROOT, { recursive: true, force: true });
  await mkdir(OUT_ROOT, { recursive: true });

  // Trusted signing key.
  const trusted = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const trustedPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', trusted.publicKey));
  await writeFile(
    join(OUT_ROOT, 'trusted-keys.json'),
    JSON.stringify({ publicKeys: [toHex(trustedPubRaw)] }, null, 2),
  );

  // Untrusted (attacker) key — NOT in trusted-keys.json.
  const attacker = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);

  const bigFile = pseudoRandomBytes(BIG_FILE_BYTES, 0xc0ffee);
  const metaFile = new TextEncoder().encode('sparklab sample toolchain pack — Stage 0 fixture');

  console.log(`Building sample-toolchain (${(BIG_FILE_BYTES / 1024 / 1024).toFixed(0)}MB)…`);
  await buildPack(
    join(OUT_ROOT, 'sample-toolchain'),
    [
      { path: 'lib/toolchain.bin', bytes: bigFile },
      { path: 'meta.txt', bytes: metaFile },
    ],
    trusted.privateKey,
    { packType: 'toolchain', name: 'sample-toolchain', version: '1.0.0' },
  );

  console.log('Building forged-toolchain (signed by untrusted key)…');
  await buildPack(
    join(OUT_ROOT, 'forged-toolchain'),
    [{ path: 'meta.txt', bytes: metaFile }],
    attacker.privateKey,
    { packType: 'toolchain', name: 'forged-toolchain', version: '1.0.0' },
  );

  console.log(`Fixtures written to ${OUT_ROOT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
