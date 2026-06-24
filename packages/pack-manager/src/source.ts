/**
 * PackSource abstracts where pack bytes come from, so install logic is testable
 * with in-memory fakes and runs unchanged against an HTTP origin (self-hosted,
 * COEP-friendly). On-wire layout:
 *   <base>/manifest.json          signed PackManifestBase
 *   <base>/files/<path>.zst       each file, zstd-compressed
 */

import type { PackManifestBase } from '@sparklab/shared';
import {
  downloadBytes,
  downloadJson,
  type ProgressCallback,
  type DownloadLimits,
} from './download.js';

export interface PackSource {
  manifest(): Promise<PackManifestBase>;
  /** Fetch the zstd-compressed bytes for a logical file path. */
  file(path: string, onProgress?: ProgressCallback): Promise<Uint8Array>;
}

export class HttpPackSource implements PackSource {
  constructor(
    private readonly baseUrl: string,
    private readonly init?: RequestInit,
    private readonly limits?: DownloadLimits,
  ) {}

  manifest(): Promise<PackManifestBase> {
    return downloadJson<PackManifestBase>(`${this.baseUrl}/manifest.json`, this.init);
  }

  file(path: string, onProgress?: ProgressCallback): Promise<Uint8Array> {
    return downloadBytes(`${this.baseUrl}/files/${path}.zst`, onProgress, this.init, this.limits);
  }
}
