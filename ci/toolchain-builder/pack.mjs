/**
 * Assemble + Ed25519-sign toolchain/SDK packs from a build output directory.
 * Output matches packages/pack-manager (manifest.json + files/<path>.zst, sha256
 * per file). Reuses the canonical manifest serialization from
 * packages/pack-manager/src/verify.ts (keep in sync).
 *
 * Usage: SIGNING_KEY=./keys/avr.private node pack.mjs <out-dir>
 *   <out-dir> may contain subdirs (binutils/, gcc/, arduino-avr-core/); each
 *   recognized subdir becomes a pack.
 */
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { init as zstdInit, compress as zstdCompress } from '@bokuweb/zstd-wasm';

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (b) =>
  `sha256:${toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', b)))}`;

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push({ path: relative(base, p), abs: p });
  }
  return out;
}

function canonicalManifestBytes(m) {
  const c = {
    packType: m.packType,
    name: m.name,
    version: m.version,
    files: [...m.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
  return new TextEncoder().encode(JSON.stringify(c));
}

async function loadPrivateKey() {
  const keyPath = process.env.SIGNING_KEY;
  if (!keyPath) throw new Error('set SIGNING_KEY=<path to PKCS8 Ed25519 private key (raw bytes)>');
  const pkcs8 = readFileSync(keyPath);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

const PACKS = {
  binutils: { name: 'avr-binutils-wasm', packType: 'toolchain', version: '2.43.0' },
  gcc: { name: 'avr-gcc-wasm-singlethread', packType: 'toolchain', version: '14.2.0' },
  'arduino-avr-core': { name: 'arduino-avr-core', packType: 'sdk', version: '1.8.6' },
};

async function buildPack(outRoot, subdir, meta, privateKey) {
  const dir = join(outRoot, subdir);
  const files = walk(dir);
  const manifestFiles = [];
  const packDir = join(outRoot, 'packs', `${meta.name}@${meta.version}`);
  mkdirSync(join(packDir, 'files'), { recursive: true });
  for (const f of files) {
    const bytes = readFileSync(f.abs);
    manifestFiles.push({ path: f.path, sha256: await sha256Hex(bytes) });
    const dest = join(packDir, 'files', `${f.path}.zst`);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, Buffer.from(zstdCompress(new Uint8Array(bytes), 19)));
  }
  const unsigned = { ...meta, files: manifestFiles, signature: 'ed25519:' };
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, canonicalManifestBytes(unsigned)),
  );
  writeFileSync(
    join(packDir, 'manifest.json'),
    JSON.stringify({ ...unsigned, signature: `ed25519:${toHex(sig)}` }, null, 2),
  );
  console.log(`packed ${meta.name}@${meta.version} (${manifestFiles.length} files) → ${packDir}`);
}

async function main() {
  const outRoot = process.argv[2];
  if (!outRoot) throw new Error('usage: node pack.mjs <out-dir>');
  await zstdInit();
  const privateKey = await loadPrivateKey();
  for (const [subdir, meta] of Object.entries(PACKS)) {
    try {
      statSync(join(outRoot, subdir));
    } catch {
      console.log(`skip ${subdir} (not built)`);
      continue;
    }
    await buildPack(outRoot, subdir, meta, privateKey);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
