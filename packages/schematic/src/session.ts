/**
 * EditorSession — the high-level facade a UI store (Vue/whatever) wraps. It binds the document +
 * history + commands + validation + netlist preview + persistence into one stateful object so the UI
 * doesn't re-implement editing plumbing: it generates fresh component/wire ids, stamps modifiedAt on
 * every edit, validates connections before making them, and notifies subscribers so the view can
 * re-render and debounce autosave. Still framework-agnostic (no DOM/Vue).
 */
import type { CircuitDocument, PinRef, PropValue, Rotation } from './types.js';
import type { DocumentIssue } from './document.js';
import {
  emptyDocument,
  newComponent,
  validateDocument,
  pinRefExists,
  isValidComponentId,
} from './document.js';
import {
  addComponent,
  removeComponent,
  moveComponent,
  rotateComponent,
  setProp,
  renameComponent,
  addWire,
  removeWire,
  setDocumentName,
  setSketchKey,
  touch,
} from './commands.js';
import { EditorHistory, type HistoryOptions, type DocTransform } from './history.js';
import { documentToNetlist, type NetlistResult } from './to-netlist.js';
import { saveProject } from './persistence.js';
import type { ErcFinding } from '@sparklab/sim-kernel';
import type { VirtualFs } from '@sparklab/opfs';

export interface EditorSessionOptions {
  history?: HistoryOptions;
  /** Clock for stamping modifiedAt + creating documents (default Date.now). */
  now?: () => number;
}

export interface AddComponentOptions {
  rotation?: Rotation;
  props?: Record<string, PropValue>;
}

export class EditorSession {
  private readonly history: EditorHistory;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(doc: CircuitDocument, opts: EditorSessionOptions = {}) {
    this.history = new EditorHistory(doc, opts.history);
    this.now = opts.now ?? Date.now;
  }

  /** Start a session on a fresh empty document. */
  static create(
    id: string,
    name: string,
    opts: EditorSessionOptions & { boardId?: string } = {},
  ): EditorSession {
    const now = opts.now ?? Date.now;
    return new EditorSession(emptyDocument(id, name, { boardId: opts.boardId, now: now() }), opts);
  }

  get document(): CircuitDocument {
    return this.history.current;
  }
  get canUndo(): boolean {
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    return this.history.canRedo;
  }

  // ── editing (ids generated, modifiedAt stamped, subscribers notified) ───────

  /** Add a component of `type` at (x,y); returns the generated id. */
  addComponent(type: string, x: number, y: number, opts: AddComponentOptions = {}): string {
    const id = this.freshId(type);
    this.mutate((d) => addComponent(d, newComponent(id, type, x, y, opts)));
    return id;
  }
  removeComponent(id: string): void {
    this.mutate((d) => removeComponent(d, id));
  }
  moveComponent(id: string, x: number, y: number): void {
    this.mutate((d) => moveComponent(d, id, x, y));
  }
  rotateComponent(id: string, rotation: Rotation): void {
    this.mutate((d) => rotateComponent(d, id, rotation));
  }
  setProp(id: string, key: string, value: PropValue): void {
    this.mutate((d) => setProp(d, id, key, value));
  }
  /** Rename a component; returns false if the new id is invalid or already taken. */
  rename(id: string, newId: string): boolean {
    if (newId === id) return true;
    if (!isValidComponentId(newId) || this.document.components.some((c) => c.id === newId))
      return false;
    this.mutate((d) => renameComponent(d, id, newId));
    return true;
  }

  /** Connect two pins; returns the wire id, or undefined if the connection is invalid/duplicate. */
  connect(a: PinRef, b: PinRef): string | undefined {
    const d = this.document;
    if (!pinRefExists(d, a) || !pinRefExists(d, b)) return undefined;
    if (a.component === b.component && a.pin === b.pin) return undefined;
    if (d.wires.some((w) => samePair(w.from, w.to, a, b))) return undefined;
    const id = this.freshWireId();
    this.mutate((doc) => addWire(doc, { id, from: a, to: b }));
    return id;
  }
  disconnect(wireId: string): void {
    this.mutate((d) => removeWire(d, wireId));
  }

  setName(name: string): void {
    this.mutate((d) => setDocumentName(d, name));
  }
  setSketchKey(key: string | undefined): void {
    this.mutate((d) => setSketchKey(d, key));
  }

  undo(): void {
    this.transition(() => this.history.undo());
  }
  redo(): void {
    this.transition(() => this.history.redo());
  }
  /** Replace the document outright (last-write-wins autosave/remote sync). */
  replace(doc: CircuitDocument): void {
    this.transition(() => this.history.replace(doc));
  }

  // ── analysis (live, derived) ────────────────────────────────────────────────

  validate(): DocumentIssue[] {
    return validateDocument(this.document);
  }
  netlist(): NetlistResult {
    return documentToNetlist(this.document);
  }
  /** Structural (document) + electrical (ERC) problems, for a UI problems panel. */
  problems(): { structural: DocumentIssue[]; electrical: ErcFinding[] } {
    return { structural: validateDocument(this.document), electrical: this.netlist().erc };
  }

  // ── persistence ─────────────────────────────────────────────────────────────

  /** Persist the current document (modifiedAt already stamped by edits). */
  async save(fs: VirtualFs): Promise<void> {
    await saveProject(fs, this.document);
  }

  // ── change notification (for re-render + debounced autosave) ────────────────

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private mutate(fn: DocTransform): void {
    const before = this.history.current;
    this.history.apply((d) => {
      const next = fn(d);
      return next === d ? d : touch(next, this.now());
    });
    if (this.history.current !== before) this.emit();
  }
  private transition(op: () => void): void {
    const before = this.history.current;
    op();
    if (this.history.current !== before) this.emit();
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }
  private freshId(prefix: string): string {
    const ids = new Set(this.document.components.map((c) => c.id));
    let n = 1;
    while (ids.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }
  private freshWireId(): string {
    const ids = new Set(this.document.wires.map((w) => w.id));
    let n = 1;
    while (ids.has(`w${n}`)) n++;
    return `w${n}`;
  }
}

function samePin(a: PinRef, b: PinRef): boolean {
  return a.component === b.component && a.pin === b.pin;
}
function samePair(wFrom: PinRef, wTo: PinRef, a: PinRef, b: PinRef): boolean {
  return (samePin(wFrom, a) && samePin(wTo, b)) || (samePin(wFrom, b) && samePin(wTo, a));
}
