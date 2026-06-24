/**
 * Link step: combine objects (stable order) into an ELF via the toolchain, then
 * optionally persist it to OPFS as a content-addressed firmware artifact keyed by
 * FirmwareCacheKeyInput (§11). Image packing (HEX/flash) is Stage 2/4.
 */

import type { Sha256, FirmwareCacheKeyInput, Diagnostic } from '@sparklab/shared';
import { firmwareCacheKey, bareHash } from '@sparklab/shared';
import { type VirtualFs, type BuildIndex, firmwarePath } from '@sparklab/opfs';
import type { Toolchain } from '@sparklab/toolchain-loader';

export interface LinkObjectsResult {
  elf: Uint8Array;
  map: string;
  diagnostics: Diagnostic[];
}

export function linkObjects(
  toolchain: Toolchain,
  objects: Uint8Array[],
  target: string,
  flags: string[] = [],
): Promise<LinkObjectsResult> {
  return toolchain.link({ objects, target, flags });
}

export interface StoredFirmware {
  firmwareKey: Sha256;
  elfPath: string;
}

export async function storeFirmware(
  fs: VirtualFs,
  index: BuildIndex,
  firmwareKeyInput: FirmwareCacheKeyInput,
  elf: Uint8Array,
): Promise<StoredFirmware> {
  const firmwareKey = await firmwareCacheKey(firmwareKeyInput);
  const elfPath = firmwarePath(bareHash(firmwareKey), 'elf');
  await fs.writeFile(elfPath, elf);
  await index.putFirmware(firmwareKey, { boardId: firmwareKeyInput.boardId, path: elfPath });
  return { firmwareKey, elfPath };
}
