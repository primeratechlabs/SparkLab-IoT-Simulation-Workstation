/**
 * Content-addressing primitives (invariant I5).
 * sha256 via WebCrypto — available in both browser and Node >=20.
 */

import type { Sha256 } from './types.js';

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('sha256:') ? hex.slice(7) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex string must have even length');
  // Reject non-hex up front — parseInt would otherwise yield NaN (coerced to 0),
  // silently corrupting the bytes instead of failing.
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('invalid hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

const textEncoder = new TextEncoder();

export function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === 'string') return textEncoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/** Returns a content hash prefixed `sha256:` over the raw bytes. */
export async function sha256(data: string | Uint8Array | ArrayBuffer): Promise<Sha256> {
  const bytes = toBytes(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

/** Hash a list of already-computed hashes (stable order preserved by caller). */
export async function sha256OfHashes(parts: Sha256[]): Promise<Sha256> {
  return sha256(parts.join('\n'));
}

/** Strip the `sha256:` prefix; throws if a different algorithm is encountered. */
export function bareHash(h: Sha256): string {
  if (!h.startsWith('sha256:')) throw new Error(`expected sha256-prefixed hash, got: ${h}`);
  return h.slice(7);
}
