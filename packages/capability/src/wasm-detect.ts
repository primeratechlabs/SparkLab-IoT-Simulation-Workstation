/**
 * WebAssembly feature detection via WebAssembly.validate on tiny modules.
 * Byte sequences are the canonical minimal modules used by wasm-feature-detect.
 */

// (module (func (result v128) i32.const 0 i8x16.splat))  — requires SIMD
const SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

export function detectWasm(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function';
}

export function detectWasmSimd(): boolean {
  if (!detectWasm()) return false;
  try {
    return WebAssembly.validate(SIMD_MODULE);
  } catch {
    return false;
  }
}

/**
 * Threads need a shared WebAssembly.Memory, which itself requires SharedArrayBuffer,
 * which the browser only exposes when cross-origin isolated.
 */
export function detectWasmThreads(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  try {
    // Will throw if shared memory is not permitted in this context.
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
}
