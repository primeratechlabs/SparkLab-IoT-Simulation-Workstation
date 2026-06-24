/**
 * Stage 7 — Subresource Integrity (SRI) for self-hosted assets. The app loads its own bundle +
 * the (large) toolchain WASM modules; SRI lets us verify each asset's bytes match an expected
 * `<algo>-<base64-digest>` before trusting it, so a swapped/corrupted asset is caught. Pure
 * (WebCrypto) — works in the browser and Node.
 */

const SRI_ALGOS: Record<string, AlgorithmIdentifier> = {
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Compute the SRI integrity string (`sha384-<base64>` by default) for some bytes. */
export async function computeSri(
  bytes: Uint8Array,
  algo: 'sha256' | 'sha384' | 'sha512' = 'sha384',
): Promise<string> {
  const digest = await crypto.subtle.digest(SRI_ALGOS[algo]!, bytes as unknown as ArrayBuffer);
  return `${algo}-${base64(new Uint8Array(digest))}`;
}

/** True if `bytes` match the integrity string. Unknown/malformed algorithms fail closed. */
export async function verifySri(bytes: Uint8Array, integrity: string): Promise<boolean> {
  const dash = integrity.indexOf('-');
  if (dash <= 0) return false;
  const algo = integrity.slice(0, dash);
  if (!(algo in SRI_ALGOS)) return false;
  const actual = await computeSri(bytes, algo as 'sha256' | 'sha384' | 'sha512');
  return actual === integrity;
}

/** Verify a set of assets against an integrity map; returns the paths that FAILED (empty = all ok). */
export async function verifyAssets(
  assets: Iterable<{ path: string; bytes: Uint8Array }>,
  integrityByPath: Record<string, string>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const a of assets) {
    const want = integrityByPath[a.path];
    if (!want || !(await verifySri(a.bytes, want))) failed.push(a.path);
  }
  return failed;
}
