/**
 * Pack integrity & authenticity — invariant I6.
 *   - Per-file content hash (sha256) must match the manifest.
 *   - Manifest must carry a valid Ed25519 signature from a trusted key.
 * A pack failing either check is rejected before install.
 */

import type { PackManifestBase, Ed25519Sig } from '@sparklab/shared';
import { sha256, fromHex, toHex } from '@sparklab/shared';

/**
 * Canonical byte string signed/verified for a manifest. Excludes the signature
 * field; files are sorted by path so ordering can't change the signed bytes.
 */
export function canonicalManifestBytes(manifest: PackManifestBase): Uint8Array {
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

function parseEd25519Sig(sig: Ed25519Sig): Uint8Array {
  if (!sig.startsWith('ed25519:')) throw new Error(`expected ed25519-prefixed signature`);
  return fromHex(sig.slice('ed25519:'.length));
}

/** Import a raw 32-byte Ed25519 public key for verification. */
async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, [
    'verify',
  ]);
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Verify the manifest signature against any of the trusted public keys. */
export async function verifyManifestSignature(
  manifest: PackManifestBase,
  trustedPublicKeys: Uint8Array[],
): Promise<VerifyResult> {
  if (!manifest.signature) return { ok: false, reason: 'missing signature' };
  let sigBytes: Uint8Array;
  try {
    sigBytes = parseEd25519Sig(manifest.signature);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const data = canonicalManifestBytes(manifest);
  for (const raw of trustedPublicKeys) {
    try {
      const key = await importPublicKey(raw);
      const ok = await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        sigBytes as BufferSource,
        data as BufferSource,
      );
      if (ok) return { ok: true };
    } catch {
      /* try next key */
    }
  }
  return { ok: false, reason: 'no trusted key validates the signature' };
}

/** Verify a single decompressed file's bytes against its manifest sha256. */
export async function verifyFileHash(bytes: Uint8Array, expected: string): Promise<VerifyResult> {
  const actual = await sha256(bytes);
  return actual === expected
    ? { ok: true }
    : { ok: false, reason: `hash mismatch: expected ${expected}, got ${actual}` };
}

// ───────────────────── signing (fixtures / CI key tooling) ─────────────────────

export interface Ed25519KeyPairRaw {
  publicKey: Uint8Array; // 32 bytes
  privateKey: CryptoKey;
}

export async function generateSigningKeyPair(): Promise<Ed25519KeyPairRaw> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: rawPub, privateKey: pair.privateKey };
}

/** Produce the `ed25519:<hex>` signature for a manifest (used by the fixture builder). */
export async function signManifest(
  manifest: PackManifestBase,
  privateKey: CryptoKey,
): Promise<Ed25519Sig> {
  const data = canonicalManifestBytes(manifest);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data as BufferSource),
  );
  return `ed25519:${toHex(sig)}`;
}
