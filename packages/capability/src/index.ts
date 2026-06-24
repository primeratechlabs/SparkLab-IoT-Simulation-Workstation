export { classifyTier, type TierInput } from './tier.js';
export { planExecution, type BoardHint } from './planner.js';
export {
  collectCapabilityProfile,
  type ProfilerOptions,
  type BenchmarkResults,
} from './profiler.js';
export {
  runBenchmarks,
  benchmarkWasmInstantiate,
  benchmarkOpfs,
  buildLargeWasmModule,
} from './benchmark.js';
export { detectWasm, detectWasmSimd, detectWasmThreads } from './wasm-detect.js';
