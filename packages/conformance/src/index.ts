/**
 * @sparklab/conformance — golden-trace differential testing (REFERENCE-SPEC §18, gate
 * #7). Compares a simulator-recorded trace against a reference; references are
 * uncalibrated until a hardware rig exists (invariant I7 — see docs/fidelity-ledger.md).
 */
export * from './trace.js';
export * from './fidelity-ledger.js';
export * from './hil.js';
