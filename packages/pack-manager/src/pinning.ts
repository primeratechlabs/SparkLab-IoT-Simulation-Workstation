/**
 * Stage 7 — manifest pinning by app version. Signature verification (verify.ts) proves a pack was
 * signed by a trusted key; pinning adds defence-in-depth: a given app build only accepts the
 * EXACT pack manifests it was released with (by manifest hash). So even a validly-signed but
 * unexpected pack — e.g. from a compromised signing key, or a version-skewed pack — is refused.
 * The app ships the pin set for its version; this is the pure check.
 */
import type { Sha256 } from '@sparklab/shared';

export interface ManifestPinSet {
  /** The app version these pins belong to. */
  appVersion: string;
  /** Manifest hashes (sha256 of the canonical manifest) this app build trusts. */
  allowedManifestHashes: ReadonlySet<Sha256>;
}

/** Build a pin set from a list of hashes. */
export function manifestPinSet(appVersion: string, hashes: Iterable<Sha256>): ManifestPinSet {
  return { appVersion, allowedManifestHashes: new Set(hashes) };
}

/** True if a pack's manifest hash is pinned for this app build. An empty pin set pins nothing. */
export function isManifestPinned(manifestHash: Sha256, pins: ManifestPinSet): boolean {
  return pins.allowedManifestHashes.has(manifestHash);
}

/** Throw unless the manifest hash is pinned. Use after signature verification, before install. */
export function assertManifestPinned(manifestHash: Sha256, pins: ManifestPinSet): void {
  if (!isManifestPinned(manifestHash, pins)) {
    throw new Error(`manifest not pinned for app ${pins.appVersion}: ${manifestHash}`);
  }
}
