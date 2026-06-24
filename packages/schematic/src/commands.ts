/**
 * Editor commands — pure, immutable transforms of a CircuitDocument. Each returns a NEW document
 * (never mutates its input) so the canvas can bind to immutable state and undo/redo can snapshot
 * cheaply (see history.ts). When a command would change nothing (unknown id), it returns the SAME
 * reference, which the history layer treats as a no-op.
 *
 * Timestamps are intentionally NOT touched here (commands stay deterministic for tests); the
 * persistence/save layer stamps `modifiedAt` via `touch()`.
 */
import type { CircuitDocument, PlacedComponent, PropValue, Rotation, Wire } from './types.js';

function withComponents(doc: CircuitDocument, components: PlacedComponent[]): CircuitDocument {
  return { ...doc, components };
}
function withWires(doc: CircuitDocument, wires: Wire[]): CircuitDocument {
  return { ...doc, wires };
}
function has(doc: CircuitDocument, id: string): boolean {
  return doc.components.some((c) => c.id === id);
}

export function addComponent(doc: CircuitDocument, comp: PlacedComponent): CircuitDocument {
  return withComponents(doc, [...doc.components, comp]);
}

/** Remove a component AND cascade-delete every wire touching it. */
export function removeComponent(doc: CircuitDocument, id: string): CircuitDocument {
  if (!has(doc, id)) return doc;
  return {
    ...doc,
    components: doc.components.filter((c) => c.id !== id),
    wires: doc.wires.filter((w) => w.from.component !== id && w.to.component !== id),
  };
}

export function moveComponent(
  doc: CircuitDocument,
  id: string,
  x: number,
  y: number,
): CircuitDocument {
  if (!has(doc, id)) return doc;
  return withComponents(
    doc,
    doc.components.map((c) => (c.id === id ? { ...c, x, y } : c)),
  );
}

export function rotateComponent(
  doc: CircuitDocument,
  id: string,
  rotation: Rotation,
): CircuitDocument {
  if (!has(doc, id)) return doc;
  return withComponents(
    doc,
    doc.components.map((c) => (c.id === id ? { ...c, rotation } : c)),
  );
}

export function setProp(
  doc: CircuitDocument,
  id: string,
  key: string,
  value: PropValue,
): CircuitDocument {
  if (!has(doc, id)) return doc;
  return withComponents(
    doc,
    doc.components.map((c) => (c.id === id ? { ...c, props: { ...c.props, [key]: value } } : c)),
  );
}

/** Rename a component id and rewrite every wire endpoint that referenced it. */
export function renameComponent(doc: CircuitDocument, id: string, newId: string): CircuitDocument {
  if (!has(doc, id) || id === newId) return doc;
  return {
    ...doc,
    components: doc.components.map((c) => (c.id === id ? { ...c, id: newId } : c)),
    wires: doc.wires.map((w) => ({
      ...w,
      from: w.from.component === id ? { ...w.from, component: newId } : w.from,
      to: w.to.component === id ? { ...w.to, component: newId } : w.to,
    })),
  };
}

export function addWire(doc: CircuitDocument, wire: Wire): CircuitDocument {
  return withWires(doc, [...doc.wires, wire]);
}

export function removeWire(doc: CircuitDocument, wireId: string): CircuitDocument {
  if (!doc.wires.some((w) => w.id === wireId)) return doc;
  return withWires(
    doc,
    doc.wires.filter((w) => w.id !== wireId),
  );
}

export function setDocumentName(doc: CircuitDocument, name: string): CircuitDocument {
  return name === doc.name ? doc : { ...doc, name };
}

export function setSketchKey(doc: CircuitDocument, sketchKey: string | undefined): CircuitDocument {
  return sketchKey === doc.sketchKey ? doc : { ...doc, sketchKey };
}

/** Stamp `modifiedAt` (called by the save layer, not by structural edits). */
export function touch(doc: CircuitDocument, now: number): CircuitDocument {
  return { ...doc, modifiedAt: now };
}
