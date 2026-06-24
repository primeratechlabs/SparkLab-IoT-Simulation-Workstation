/**
 * @sparklab/workbench — debug inspectors + off-main-thread render (REFERENCE-SPEC
 * Stage 3). Signal capture + waveform geometry are pure; the OffscreenCanvas renderer
 * and Vue panels build on them.
 */
export * from './signal-trace.js';
export * from './waveform-geometry.js';
export * from './renderer.js';
export * from './protocol-inspector.js';
export * from './pwm-inspector.js';
export * from './power-erc-inspector.js';
