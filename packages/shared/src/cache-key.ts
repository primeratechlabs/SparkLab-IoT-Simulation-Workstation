/**
 * Cache key formulas — REFERENCE-SPEC §11.
 *
 * Keys are content hashes over a canonical, deterministic serialization of the
 * inputs (invariant I4/I5: same input → byte-identical key). We serialize each
 * input to a stable JSON form (fixed field order, arrays preserved as-given)
 * before hashing, so the formula is reproducible across runs and machines.
 */

import type { ObjectCacheKeyInput, FirmwareCacheKeyInput, Sha256 } from './types.js';
import { sha256 } from './hash.js';

/** Stable serialization: explicit field order, no Object key reordering surprises. */
function canonical(label: string, fields: Array<[string, unknown]>): string {
  const body = fields.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n');
  return `${label}\n${body}`;
}

export function objectCacheKey(input: ObjectCacheKeyInput): Promise<Sha256> {
  return sha256(
    canonical('object_key', [
      ['compiler_id', input.compilerId],
      ['compiler_flags', input.compilerFlags],
      ['target_triple', input.targetTriple],
      ['source_hash', input.sourceHash],
      ['included_header_hashes', input.includedHeaderHashes],
      ['sdk_pack_hash', input.sdkPackHash],
      ['library_pack_hash', input.libraryPackHash],
    ]),
  );
}

export function firmwareCacheKey(input: FirmwareCacheKeyInput): Promise<Sha256> {
  return sha256(
    canonical('firmware_key', [
      ['board_id', input.boardId],
      ['mcu_target', input.mcuTarget],
      ['framework_version', input.frameworkVersion],
      ['toolchain_pack_hash', input.toolchainPackHash],
      ['sdk_pack_hash', input.sdkPackHash],
      ['object_keys', input.objectKeys],
      ['static_library_hashes', input.staticLibraryHashes],
      ['linker_script_hash', input.linkerScriptHash],
      ['partition_table_hash', input.partitionTableHash],
      ['image_packer_version', input.imagePackerVersion],
      ['simulation_profile_id', input.simulationProfileId],
    ]),
  );
}

export interface CcacheKeyInput {
  preprocessedSourceHash: Sha256;
  compilerId: string;
  targetTriple: string;
  flags: string[];
}

export function ccacheKey(input: CcacheKeyInput): Promise<Sha256> {
  return sha256(
    canonical('ccache_key', [
      ['preprocessed_source_hash', input.preprocessedSourceHash],
      ['compiler_id', input.compilerId],
      ['target_triple', input.targetTriple],
      ['flags', input.flags],
    ]),
  );
}
