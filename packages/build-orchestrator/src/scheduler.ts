/**
 * Build scheduler — REFERENCE-SPEC §11.4 decision logic:
 *   if firmware_key in cache → run firmware immediately (skip everything)
 *   else for each unit: object cache hit → reuse, miss → compile (worker pool)
 *        then link → pack → run.
 *
 * Stage 1 runs compiles sequentially through the warm stub toolchain; the worker
 * pool (concurrency) is wired in the daemon. The reuse/recompile accounting is
 * what the acceptance gate measures.
 */

import type { Sha256, Diagnostic } from '@sparklab/shared';
import type { Toolchain } from '@sparklab/toolchain-loader';
import type { BuildIndex } from '@sparklab/opfs';
import type { ObjectCache } from './ccache.js';
import type { BuildUnitPlan } from './graph.js';

export interface ScheduleOptions {
  plans: BuildUnitPlan[];
  cache: ObjectCache;
  toolchain: Toolchain;
  /** If provided and present in firmware_cache, short-circuit the whole build. */
  firmwareKey?: Sha256;
  index?: BuildIndex;
  /** User-uploaded library headers mounted into every compile (their hashes are in each plan's
   *  includedHeaderHashes, so cache keys already reflect them). */
  extraHeaders?: { path: string; bytes: Uint8Array }[];
}

export interface ScheduleResult {
  fromFirmwareCache: boolean;
  objectKeys: Sha256[];
  compiledUnitIds: string[];
  reusedUnitIds: string[];
  /**
   * Units whose compile produced an error diagnostic (no object cached). Kept
   * explicit so accounting stays exhaustive: compiled + reused + failed === plans.
   * (objectKeys stays 1:1 with compiled + reused only.)
   */
  failedUnitIds: string[];
  diagnostics: Diagnostic[];
}

export async function scheduleBuild(opts: ScheduleOptions): Promise<ScheduleResult> {
  const { plans, cache, toolchain, firmwareKey, index } = opts;

  if (firmwareKey && index) {
    const fw = await index.getFirmware(firmwareKey);
    if (fw) {
      return {
        fromFirmwareCache: true,
        objectKeys: [],
        compiledUnitIds: [],
        reusedUnitIds: [],
        failedUnitIds: [],
        diagnostics: [],
      };
    }
  }

  const objectKeys: Sha256[] = [];
  const compiledUnitIds: string[] = [];
  const reusedUnitIds: string[] = [];
  const failedUnitIds: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const plan of plans) {
    const hit = await cache.lookup(plan.keyInput);
    if (hit) {
      objectKeys.push(hit.objectKey);
      reusedUnitIds.push(plan.unitId);
      continue;
    }

    const out = await toolchain.compile({
      sourceKey: plan.sourceKey,
      sourceBytes: plan.sourceBytes,
      target: plan.target,
      flags: plan.flags,
      includedHeaderHashes: plan.includedHeaderHashes,
      ...(plan.language ? { language: plan.language } : {}),
      ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    });
    diagnostics.push(...out.diagnostics);

    if (out.diagnostics.some((d) => d.severity === 'error')) {
      // Do not cache a failed compile; record the unit and continue collecting
      // diagnostics so the caller sees every error in one pass (early-error contract).
      failedUnitIds.push(plan.unitId);
      continue;
    }

    const objectKey = await cache.store(plan.keyInput, out.object);
    objectKeys.push(objectKey);
    compiledUnitIds.push(plan.unitId);
  }

  return {
    fromFirmwareCache: false,
    objectKeys,
    compiledUnitIds,
    reusedUnitIds,
    failedUnitIds,
    diagnostics,
  };
}
