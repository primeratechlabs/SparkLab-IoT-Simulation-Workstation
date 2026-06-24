/**
 * Prop coercion — a single home for turning loosely-typed PropValue (string | number | boolean) into
 * a concrete number/boolean. Shared by the catalog build factories and the netlist compiler so the
 * two never drift (they previously held byte-identical copies).
 */
import type { PropValue } from './types.js';

export function coerceNum(props: Record<string, PropValue>, key: string, dflt: number): number {
  const v = props[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : dflt;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return dflt;
}

export function coerceBool(props: Record<string, PropValue>, key: string, dflt: boolean): boolean {
  const v = props[key];
  if (typeof v === 'boolean') return v;
  if (v === undefined) return dflt;
  return v === 'true' || v === '1' || v === 1;
}

/** A valid 7-bit I2C address derived from props, or `dflt` when out of range / non-integer. */
export function coerceI2cAddress(props: Record<string, PropValue>, dflt: number): number {
  const a = coerceNum(props, 'address', dflt);
  return Number.isInteger(a) && a >= 0 && a <= 127 ? a : dflt;
}
