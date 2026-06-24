/**
 * Install a pack into OPFS (REFERENCE-SPEC §9/§10). Pipeline per file:
 *   fetch(.zst) → zstd decompress → verify sha256 → write to OPFS install path.
 * The manifest's Ed25519 signature is verified up-front; a bad signature or any
 * file-hash mismatch aborts the install (invariant I6). Idempotent: a pack already
 * present with all files on disk is reused, not re-downloaded.
 */

import type { PackManifestBase } from '@sparklab/shared';
import {
  type VirtualFs,
  type BuildIndex,
  packInstallPath,
  withLock,
  LOCK_NAMES,
} from '@sparklab/opfs';
import { verifyManifestSignature, verifyFileHash, canonicalManifestBytes } from './verify.js';
import { assertManifestPinned, type ManifestPinSet } from './pinning.js';
import { sha256 } from '@sparklab/shared';
import { decompressZstd } from './decompress.js';
import type { PackSource } from './source.js';
import type { ProgressInfo } from './download.js';

export interface InstallOptions {
  source: PackSource;
  fs: VirtualFs;
  index: BuildIndex;
  trustedPublicKeys: Uint8Array[];
  /**
   * If the caller knows the pack identity up-front, an already-installed pack is
   * detected WITHOUT any network fetch (not even the manifest) — guarantees zero
   * pack requests on reload (Stage 0 reuse gate).
   */
  knownPack?: { packType: string; name: string; version: string };
  /**
   * Optional manifest pin set for this app version (Stage 7). When provided, a pack whose
   * canonical manifest hash is not pinned is rejected even if validly signed — defence against
   * a compromised key or a version-skewed pack.
   */
  manifestPins?: ManifestPinSet;
  /**
   * Re-hash every on-disk pack file against the manifest before reusing it (AUD-014). Off by default so
   * the common reload stays cheap (existence-only); turn it on for the integrity-sensitive triggers —
   * first open of a session, recovery after a crash — so a locally-corrupted/edited pack file is detected
   * and the pack is reinstalled instead of silently trusted.
   */
  revalidateContent?: boolean;
  onProgress?: (p: InstallProgress) => void;
}

export interface InstallProgress {
  phase: 'verify' | 'download' | 'decompress' | 'write' | 'done' | 'reused';
  file?: string;
  filesDone: number;
  filesTotal: number;
  bytesWritten: number;
}

export interface InstallResult {
  name: string;
  version: string;
  installPath: string;
  reused: boolean;
  totalBytes: number;
}

/**
 * Reject manifest file paths that could escape the install directory (invariant
 * I6). A trusted-but-compromised pack must NOT be able to write outside its pack
 * dir via absolute paths or `..` segments. Returns the safe joined path.
 */
export function safePackPath(installPath: string, rel: string): string {
  if (
    rel === '' ||
    rel.startsWith('/') ||
    rel.includes('\\') ||
    rel.includes('\0') ||
    /(^|\/)\.\.(\/|$)/.test(rel) ||
    /(^|\/)\.(\/|$)/.test(rel)
  ) {
    throw new Error(`unsafe pack file path rejected: ${JSON.stringify(rel)}`);
  }
  return `${installPath}/${rel}`;
}

async function allFilesPresent(
  fs: VirtualFs,
  installPath: string,
  manifest: PackManifestBase,
): Promise<boolean> {
  for (const f of manifest.files) {
    if (!(await fs.exists(safePackPath(installPath, f.path)))) return false;
  }
  return true;
}

/**
 * Re-hash every on-disk pack file against the manifest (AUD-014). Returns false on the first mismatch,
 * missing file, or read error so the caller reinstalls instead of trusting a corrupted/edited local pack.
 */
async function filesIntact(
  fs: VirtualFs,
  installPath: string,
  manifest: PackManifestBase,
): Promise<boolean> {
  for (const f of manifest.files) {
    try {
      const bytes = await fs.readFile(safePackPath(installPath, f.path));
      if (!(await verifyFileHash(bytes, f.sha256)).ok) return false;
    } catch {
      return false; // unreadable/missing → treat as not intact
    }
  }
  return true;
}

/**
 * Build the "already installed" reuse result, or null if the pack is not fully
 * present on disk. Used both as a pre-lock fast path and as the in-lock re-check
 * that closes the TOCTOU window between two concurrent installs.
 */
async function tryReuse(
  fs: VirtualFs,
  index: BuildIndex,
  manifest: PackManifestBase,
  installPath: string,
  manifestHash: string,
  revalidateContent: boolean,
): Promise<InstallResult | null> {
  const existing = await index.getInstalledPack(manifest.name, manifest.version);
  if (!existing) return null;
  // The fetched manifest is signature-verified; if its canonical digest disagrees with the recorded one,
  // the install record is stale/tampered → reinstall rather than trust it (AUD-014).
  if (existing.manifestHash !== manifestHash) return null;
  if (!(await allFilesPresent(fs, installPath, manifest))) return null;
  if (revalidateContent && !(await filesIntact(fs, installPath, manifest))) return null;
  return {
    name: manifest.name,
    version: manifest.version,
    installPath,
    reused: true,
    totalBytes: existing.sizeBytes,
  };
}

export async function installPack(opts: InstallOptions): Promise<InstallResult> {
  const { source, fs, index, trustedPublicKeys, knownPack, onProgress } = opts;

  // Fast path: known pack already installed with all files on disk → no fetch.
  if (knownPack) {
    const installPath = packInstallPath(knownPack.packType, knownPack.name, knownPack.version);
    const existing = await index.getInstalledPack(knownPack.name, knownPack.version);
    if (existing && (await fs.exists(`${installPath}/manifest.json`))) {
      try {
        const localManifest = JSON.parse(
          await fs.readFileText(`${installPath}/manifest.json`),
        ) as PackManifestBase;
        const identityMatches =
          localManifest.packType === knownPack.packType &&
          localManifest.name === knownPack.name &&
          localManifest.version === knownPack.version &&
          Array.isArray(localManifest.files);
        // The local manifest.json must hash to the recorded manifestHash — a tampered/edited manifest
        // (e.g. swapped file hashes) is detected here, cheaply, without any fetch (AUD-014).
        const localHash = identityMatches
          ? await sha256(canonicalManifestBytes(localManifest))
          : '';
        const hashMatches = localHash === existing.manifestHash;
        const contentOk =
          !opts.revalidateContent ||
          (identityMatches && hashMatches && (await filesIntact(fs, installPath, localManifest)));
        if (
          identityMatches &&
          hashMatches &&
          contentOk &&
          (await allFilesPresent(fs, installPath, localManifest))
        ) {
          onProgress?.({
            phase: 'reused',
            filesDone: localManifest.files.length,
            filesTotal: localManifest.files.length,
            bytesWritten: existing.sizeBytes,
          });
          return {
            name: knownPack.name,
            version: knownPack.version,
            installPath,
            reused: true,
            totalBytes: existing.sizeBytes,
          };
        }
      } catch {
        // Corrupt local metadata falls through to the verified network path.
      }
    }
  }

  const manifest = await source.manifest();
  const installPath = packInstallPath(manifest.packType, manifest.name, manifest.version);
  const filesTotal = manifest.files.length;

  // 1. Authenticity — reject unsigned/forged manifests before touching the disk.
  onProgress?.({ phase: 'verify', filesDone: 0, filesTotal, bytesWritten: 0 });
  const sig = await verifyManifestSignature(manifest, trustedPublicKeys);
  if (!sig.ok) throw new Error(`pack signature rejected: ${sig.reason}`);

  // 1a. Manifest digest — the content-address of the canonical (signature-excluded) manifest. This is
  //     what we persist as the pack's manifestHash and what reuse re-checks against; it is NOT the
  //     signature (AUD-014: storing the signature there conflated two different values).
  const manifestHash = await sha256(canonicalManifestBytes(manifest));

  // 1b. Pinning — if this app build pins manifests, the pack must be one it shipped with.
  if (opts.manifestPins) {
    assertManifestPinned(manifestHash, opts.manifestPins);
  }

  // 1c. Path safety — reject directory-escaping file paths before any disk work (I6).
  for (const f of manifest.files) safePackPath(installPath, f.path);

  // 2. Idempotency fast path — reuse without acquiring the lock when possible.
  const reusedFast = await tryReuse(
    fs,
    index,
    manifest,
    installPath,
    manifestHash,
    opts.revalidateContent ?? false,
  );
  if (reusedFast) {
    onProgress?.({
      phase: 'reused',
      filesDone: filesTotal,
      filesTotal,
      bytesWritten: reusedFast.totalBytes,
    });
    return reusedFast;
  }

  // 3. Fetch → decompress → verify → write, serialized across tabs.
  return withLock(LOCK_NAMES.packInstall, async () => {
    // Re-check under the lock: a concurrent install may have completed while we
    // were queued, so we must not download a second copy (closes the TOCTOU gap).
    const reusedLocked = await tryReuse(
      fs,
      index,
      manifest,
      installPath,
      manifestHash,
      opts.revalidateContent ?? false,
    );
    if (reusedLocked) {
      onProgress?.({
        phase: 'reused',
        filesDone: filesTotal,
        filesTotal,
        bytesWritten: reusedLocked.totalBytes,
      });
      return reusedLocked;
    }

    await fs.mkdirp(installPath);
    let bytesWritten = 0;
    let filesDone = 0;

    try {
      for (const f of manifest.files) {
        onProgress?.({ phase: 'download', file: f.path, filesDone, filesTotal, bytesWritten });
        const compressed = await source.file(f.path, (_p: ProgressInfo) => undefined);

        onProgress?.({ phase: 'decompress', file: f.path, filesDone, filesTotal, bytesWritten });
        const bytes = decompressZstd(compressed);

        const verdict = await verifyFileHash(bytes, f.sha256);
        if (!verdict.ok) throw new Error(`pack file rejected (${f.path}): ${verdict.reason}`);

        onProgress?.({ phase: 'write', file: f.path, filesDone, filesTotal, bytesWritten });
        const dest = safePackPath(installPath, f.path);
        const slash = dest.lastIndexOf('/');
        if (slash > 0) await fs.mkdirp(dest.slice(0, slash));
        await fs.writeFile(dest, bytes);

        bytesWritten += bytes.length;
        filesDone += 1;
      }

      // Persist the manifest alongside the files for offline health checks.
      await fs.writeFile(`${installPath}/manifest.json`, JSON.stringify(manifest));
    } catch (e) {
      // A mid-loop verify/download/write failure leaves a partial install. Remove
      // it so a later retry sees a clean slate (no half-written pack on disk).
      await fs.remove(installPath).catch(() => undefined);
      throw e;
    }

    await index.recordInstalledPack({
      name: manifest.name,
      version: manifest.version,
      packType: manifest.packType,
      manifestHash, // canonical manifest digest, not the signature (AUD-014)
      sizeBytes: bytesWritten,
      installedAt: Date.now(),
    });

    onProgress?.({ phase: 'done', filesDone, filesTotal, bytesWritten });
    return {
      name: manifest.name,
      version: manifest.version,
      installPath,
      reused: false,
      totalBytes: bytesWritten,
    };
  });
}
