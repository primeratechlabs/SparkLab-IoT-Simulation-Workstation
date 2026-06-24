/** Toolchain variant selection from the capability planner's ExecutionPlan. */

import type { ExecutionPlan } from '@sparklab/shared';

export function selectVariant(
  plan: Pick<ExecutionPlan, 'toolchainVariant'>,
): 'threaded' | 'singlethread' {
  return plan.toolchainVariant;
}
