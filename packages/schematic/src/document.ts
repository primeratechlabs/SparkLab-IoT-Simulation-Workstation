/**
 * Document helpers — construction, lookups, and validation over a CircuitDocument. Validation is
 * STRUCTURAL (unique ids, known types/board, wires reference real pins); ELECTRICAL checks live in
 * the netlist/ERC layer (to-netlist.ts), because they need the compiled net graph.
 */
import type { CircuitDocument, PlacedComponent, PinRef, PropValue, Rotation } from './types.js';
import { MCU_REF, SCHEMATIC_SCHEMA_VERSION } from './types.js';
import { catalogEntry, defaultPropsFor } from './catalog.js';
import { boardEntry, boardPin } from './board.js';

export interface DocumentIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  refs: string[];
}

/**
 * A component id must be non-empty, not the reserved MCU id, and free of whitespace/control chars
 * (the net graph keys on `component<NUL>pin`, and whitespace ids would also confuse the UI). The UI
 * and EditorSession should reject invalid ids up-front; validateDocument flags any that slip in.
 */
export function isValidComponentId(id: string): boolean {
  if (id.length === 0 || id === MCU_REF || /\s/.test(id)) return false;
  for (let i = 0; i < id.length; i++) if (id.charCodeAt(i) < 0x20) return false;
  return true;
}

/** A fresh, empty document for `boardId` (default Arduino Uno). `now` is injectable for determinism. */
export function emptyDocument(
  id: string,
  name: string,
  opts: { boardId?: string; now?: number } = {},
): CircuitDocument {
  const now = opts.now ?? Date.now();
  return {
    schemaVersion: SCHEMATIC_SCHEMA_VERSION,
    id,
    name,
    board: { id: opts.boardId ?? 'arduino-uno', x: 0, y: 0, rotation: 0 },
    components: [],
    wires: [],
    createdAt: now,
    modifiedAt: now,
  };
}

/** Build a placed component pre-filled with its catalog default props. */
export function newComponent(
  id: string,
  type: string,
  x: number,
  y: number,
  opts: { rotation?: Rotation; props?: Record<string, PropValue> } = {},
): PlacedComponent {
  return {
    id,
    type,
    x,
    y,
    rotation: opts.rotation ?? 0,
    props: { ...defaultPropsFor(type), ...(opts.props ?? {}) },
  };
}

export function getComponent(doc: CircuitDocument, id: string): PlacedComponent | undefined {
  return doc.components.find((c) => c.id === id);
}

/** Pin names declared by a component type's catalog entry. */
export function componentPinNames(type: string): string[] {
  return catalogEntry(type)?.pins.map((p) => p.name) ?? [];
}

/** Does a PinRef address a real pin (a board MCU pin, or a placed component's catalog pin)? */
export function pinRefExists(doc: CircuitDocument, ref: PinRef): boolean {
  if (ref.component === MCU_REF) return boardPin(doc.board.id, ref.pin) !== undefined;
  const comp = getComponent(doc, ref.component);
  if (!comp) return false;
  return componentPinNames(comp.type).includes(ref.pin);
}

/** Structural validation: unique ids, known board/types, wires reference real pins, no self-wires. */
export function validateDocument(doc: CircuitDocument): DocumentIssue[] {
  const issues: DocumentIssue[] = [];

  if (doc.schemaVersion !== SCHEMATIC_SCHEMA_VERSION) {
    issues.push({
      severity: 'warning',
      code: 'schema-version',
      message: `document schemaVersion ${doc.schemaVersion} ≠ ${SCHEMATIC_SCHEMA_VERSION}`,
      refs: [],
    });
  }
  if (!boardEntry(doc.board.id)) {
    issues.push({
      severity: 'error',
      code: 'unknown-board',
      message: `unknown board '${doc.board.id}'`,
      refs: [doc.board.id],
    });
  }

  const seen = new Set<string>();
  for (const c of doc.components) {
    if (c.id === MCU_REF) {
      issues.push({
        severity: 'error',
        code: 'reserved-id',
        message: `component id '${MCU_REF}' is reserved for the board MCU`,
        refs: [c.id],
      });
    } else if (!isValidComponentId(c.id)) {
      issues.push({
        severity: 'error',
        code: 'invalid-id',
        message: `component id '${c.id}' is empty or has whitespace/control characters`,
        refs: [c.id],
      });
    }
    if (seen.has(c.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `duplicate component id '${c.id}'`,
        refs: [c.id],
      });
    }
    seen.add(c.id);
    if (!catalogEntry(c.type)) {
      issues.push({
        severity: 'error',
        code: 'unknown-type',
        message: `unknown component type '${c.type}' on '${c.id}'`,
        refs: [c.id],
      });
    }
  }

  const wireIds = new Set<string>();
  for (const w of doc.wires) {
    if (wireIds.has(w.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-wire',
        message: `duplicate wire id '${w.id}'`,
        refs: [w.id],
      });
    }
    wireIds.add(w.id);
    if (w.from.component === w.to.component && w.from.pin === w.to.pin) {
      issues.push({
        severity: 'error',
        code: 'self-wire',
        message: `wire '${w.id}' connects a pin to itself`,
        refs: [w.id],
      });
    }
    if (!pinRefExists(doc, w.from)) {
      issues.push({
        severity: 'error',
        code: 'dangling-wire',
        message: `wire '${w.id}' endpoint ${w.from.component}.${w.from.pin} references a missing pin`,
        refs: [w.id, w.from.component],
      });
    }
    if (!pinRefExists(doc, w.to)) {
      issues.push({
        severity: 'error',
        code: 'dangling-wire',
        message: `wire '${w.id}' endpoint ${w.to.component}.${w.to.pin} references a missing pin`,
        refs: [w.id, w.to.component],
      });
    }
  }

  return issues;
}

export function hasErrors(issues: DocumentIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
