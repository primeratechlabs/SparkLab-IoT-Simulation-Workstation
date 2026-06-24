/**
 * @sparklab/schematic — headless logic layer for the visual drag-and-drop circuit editor.
 *
 * This package owns the EDITABLE circuit document (placed components + wires at coordinates),
 * the component catalog, editor commands + undo/redo, pin/hit-test geometry, serialization +
 * OPFS persistence, and the bridge that compiles a drawn document DOWN to the simulator's
 * logical netlist (`@sparklab/sim-kernel`) and instantiates runnable `SimComponent`s
 * (`@sparklab/components-core`) so a dragged circuit actually runs on the kernel.
 *
 * It is framework-agnostic (no DOM / Vue) so the UI layer binds to it; the design of the visual
 * canvas is deliberately decoupled — only this logic is built first.
 */
export * from './types.js';
export * from './catalog.js';
export * from './breadboard.js';
export * from './board.js';
export * from './document.js';
export * from './commands.js';
export * from './history.js';
export * from './geometry.js';
export * from './netgraph.js';
export * from './readiness.js';
export * from './to-netlist.js';
export * from './instantiate.js';
export * from './device-runtime.js';
export * from './serialize.js';
export * from './persistence.js';
export * from './session.js';
