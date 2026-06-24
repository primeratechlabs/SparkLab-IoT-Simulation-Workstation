/**
 * Toolchain-asset integrity verification (AUD-013). The compiler/linker WASM modules + SDK packs are
 * self-hosted and blob-imported — a tampered or substituted asset would otherwise execute unverified. This
 * module pins each shipped asset to a SHA-256 written into `integrity.json` at pack-build time, and the
 * loaders verify every byte BEFORE the blob-import / mount. Pure + testable (uses Web Crypto, present in the
 * Worker and in Node ≥20); the fetch is injectable so the policy can be exercised without a server.
 *
 * Policy: when an `integrity.json` is present, verification is ENFORCED (a missing pin for a loaded asset, or
 * a hash mismatch, throws BEFORE the asset is used). When it is absent the loader proceeds with a loud
 * console warning — so production packs (always regenerated with a manifest) are fail-closed, while a
 * dev/legacy pack without one still runs.
 */

export class AssetIntegrityError extends Error {
  constructor(
    public readonly asset: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `integrity check FAILED for "${asset}": expected sha256 ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}… — refusing to load a tampered/substituted toolchain asset`,
    );
    this.name = 'AssetIntegrityError';
  }
}

/** filename → lowercase hex SHA-256. */
export type IntegrityManifest = Record<string, string>;

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle)
    throw new Error('Web Crypto (crypto.subtle) unavailable — cannot verify toolchain integrity');
  return c.subtle;
};

/** SHA-256 of `bytes` as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh standalone ArrayBuffer so we hash ONLY this view's bytes (a subarray over a larger
  // buffer would otherwise risk hashing the whole backing store) and never hand digest a SharedArrayBuffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle().digest('SHA-256', copy);
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Throw {@link AssetIntegrityError} if `bytes` does not hash to `expectedHex` (case-insensitive). */
export async function verifyAssetIntegrity(
  bytes: Uint8Array,
  expectedHex: string,
  asset: string,
): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expectedHex.trim().toLowerCase())
    throw new AssetIntegrityError(asset, expectedHex, actual);
}

/**
 * Resolve the pin for `name` and verify `bytes` against it. Returns `bytes` unchanged on success.
 *  - manifest present + has a pin for `name` → verify (throws on mismatch).
 *  - manifest present but NO pin for `name`  → throw (an unpinned asset under an enforced manifest is unsafe).
 *  - manifest null/absent → no-op (caller already warned once); returns `bytes`.
 */
export async function enforcePin(
  bytes: Uint8Array,
  name: string,
  manifest: IntegrityManifest | null,
): Promise<Uint8Array> {
  if (!manifest) return bytes;
  const pin = manifest[name];
  if (!pin)
    throw new AssetIntegrityError(
      name,
      '(pinned manifest has no entry for this asset)',
      await sha256Hex(bytes),
    );
  await verifyAssetIntegrity(bytes, pin, name);
  return bytes;
}

/** Verify `bytes` against its pin ONLY if the manifest lists `name` (for OPTIONAL assets — an absent pin is
 *  allowed, but a present pin is enforced, so a served-but-tampered optional asset is still caught). */
export async function verifyIfPinned(
  bytes: Uint8Array,
  name: string,
  manifest: IntegrityManifest | null,
): Promise<Uint8Array> {
  const pin = manifest?.[name];
  if (pin) await verifyAssetIntegrity(bytes, pin, name);
  return bytes;
}

/** Fetch `${base}/integrity.json`. Returns null (with a single loud warning) when absent — see policy above. */
export async function fetchIntegrityManifest(
  base: string,
  fetchFn: typeof fetch = fetch,
): Promise<IntegrityManifest | null> {
  let res: Response;
  try {
    res = await fetchFn(`${base}/integrity.json`);
  } catch {
    res = { ok: false } as Response;
  }
  if (!res.ok) {
    console.warn(
      `[integrity] no integrity.json under ${base} — toolchain assets will NOT be verified (regenerate the pack to pin them)`,
    );
    return null;
  }
  return (await res.json()) as IntegrityManifest;
}

/** Fetch `url`, verify it against the manifest pin for `name`, return the raw bytes. Fail-closed on mismatch. */
export async function fetchVerifiedBytes(
  url: string,
  name: string,
  manifest: IntegrityManifest | null,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`toolchain fetch failed (${res.status}) for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return enforcePin(bytes, name, manifest);
}
