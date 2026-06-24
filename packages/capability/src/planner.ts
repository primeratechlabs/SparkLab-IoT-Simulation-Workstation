/**
 * Execution planner (skeleton) — REFERENCE-SPEC §15 + invariants I8/I9.
 *
 * Stage 0 scope: choose toolchain variant (threaded vs single-thread) and a
 * coarse build mode from the capability tier. Full per-board planning (toolchain
 * pack variant selection, appliance vs native, fallback policy) lands in Stage 4.
 *
 * Hard rule (I8): never selects "backend-fallback" — backend compile is OFF by
 * default; only an explicit policy override (not modeled here) may enable it.
 */

import type { CapabilityProfile, ExecutionPlan } from '@sparklab/shared';

export interface BoardHint {
  boardId: string;
  architecture: 'avr' | 'riscv32' | 'xtensa';
}

export function planExecution(profile: CapabilityProfile, board?: BoardHint): ExecutionPlan {
  const reasons: string[] = [];
  const threaded = profile.crossOriginIsolated && profile.sharedArrayBuffer && profile.atomics;
  const toolchainVariant: ExecutionPlan['toolchainVariant'] = threaded
    ? 'threaded'
    : 'singlethread';

  if (!threaded) {
    reasons.push('crossOriginIsolated/SAB unavailable → single-thread toolchain');
  }

  let buildMode: ExecutionPlan['buildMode'];
  switch (profile.tier) {
    case 'S':
    case 'A':
      buildMode = 'client-native-wasm-compile';
      reasons.push(`tier ${profile.tier}: full client-side native WASM compile`);
      break;
    case 'B':
      buildMode = 'client-native-wasm-compile';
      reasons.push('tier B: client compile on single-thread path, reduced simulation fidelity');
      break;
    case 'C':
      buildMode = 'cached-firmware';
      reasons.push('tier C: limited storage/OPFS → prefer cached firmware, small targets only');
      break;
    case 'D':
    default:
      buildMode = 'preview';
      reasons.push('tier D: unsupported browser → preview-only (no firmware build)');
      break;
  }

  if (board) {
    reasons.push(`board ${board.boardId} (${board.architecture})`);
  }

  return {
    buildMode,
    toolchainVariant,
    emulatorProfile: board ? `${board.architecture}-default` : 'default',
    reasons,
  };
}
