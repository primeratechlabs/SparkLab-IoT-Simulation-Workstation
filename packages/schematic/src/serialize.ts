/**
 * Serialization — canonical JSON for the document so identical content yields identical bytes
 * (reproducibility I4/I5: a content hash is stable regardless of key insertion order). Object keys
 * are sorted recursively; ARRAY order is preserved (component z-order and wire order are meaningful).
 * `parseDocument` is the trust boundary for OPFS-loaded / foreign files: it DEEP-validates the shape
 * (components, wires, rotations, pin refs) and throws loudly, so malformed data never reaches the
 * geometry/netlist layers as NaN coordinates or thrown key lookups.
 */
import type { CircuitDocument } from './types.js';

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Compact canonical JSON (sorted keys, array order kept) — the byte-exact form used for hashing. */
export function canonicalJson(doc: CircuitDocument): string {
  return JSON.stringify(canonicalize(doc));
}

/** Pretty, deterministic JSON for storage (sorted keys, 2-space indent). */
export function serializeDocument(doc: CircuitDocument): string {
  return JSON.stringify(canonicalize(doc), null, 2);
}

/** Content hash of the canonical document bytes (`sha256:<hex>`). */
export async function documentHash(doc: CircuitDocument): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(doc));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export class DocumentParseError extends Error {}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const ROTATIONS: ReadonlySet<unknown> = new Set([0, 90, 180, 270]);

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** Parse + DEEP-validate persisted JSON into a CircuitDocument (throws DocumentParseError on malformed). */
export function parseDocument(json: string): CircuitDocument {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch (e) {
    throw new DocumentParseError(`invalid JSON: ${(e as Error).message}`);
  }
  if (!isObj(v)) throw new DocumentParseError('document is not an object');
  const need = (cond: boolean, msg: string): void => {
    if (!cond) throw new DocumentParseError(msg);
  };

  need(isNum(v.schemaVersion), 'missing schemaVersion');
  need(isStr(v.id), 'missing id');
  need(isStr(v.name), 'missing name');
  need(isNum(v.createdAt), 'missing createdAt');
  need(isNum(v.modifiedAt), 'missing modifiedAt');

  need(isObj(v.board), 'missing board');
  const board = v.board as Record<string, unknown>;
  need(isStr(board.id), 'missing board.id');
  need(isNum(board.x) && isNum(board.y), 'board.x/y must be numbers');
  need(ROTATIONS.has(board.rotation), 'board.rotation must be 0/90/180/270');

  need(Array.isArray(v.components), 'components must be an array');
  (v.components as unknown[]).forEach((c, i) => {
    need(isObj(c), `components[${i}] is not an object`);
    const o = c as Record<string, unknown>;
    need(isStr(o.id) && o.id.length > 0, `components[${i}].id must be a non-empty string`);
    need(isStr(o.type), `components[${i}].type must be a string`);
    need(isNum(o.x) && isNum(o.y), `components[${i}].x/y must be numbers`);
    need(ROTATIONS.has(o.rotation), `components[${i}].rotation must be 0/90/180/270`);
    need(isObj(o.props), `components[${i}].props must be an object`);
  });

  need(Array.isArray(v.wires), 'wires must be an array');
  (v.wires as unknown[]).forEach((w, i) => {
    need(isObj(w), `wires[${i}] is not an object`);
    const o = w as Record<string, unknown>;
    need(isStr(o.id), `wires[${i}].id must be a string`);
    for (const end of ['from', 'to'] as const) {
      need(isObj(o[end]), `wires[${i}].${end} must be an object`);
      const e = o[end] as Record<string, unknown>;
      need(
        isStr(e.component) && isStr(e.pin),
        `wires[${i}].${end} must have string component + pin`,
      );
    }
  });

  return v as unknown as CircuitDocument;
}
