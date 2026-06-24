/**
 * Undo/redo history — snapshots the immutable document before each edit. Because commands.ts
 * transforms are pure and return new documents, snapshotting the prior reference is a complete,
 * bug-free undo model (no fragile inverse commands). `replace()` supports last-write-wins sync:
 * an autosave/remote load swaps the document outright while staying undoable.
 */
import type { CircuitDocument } from './types.js';

export interface HistoryOptions {
  /** Max undo depth (older states are dropped). */
  maxDepth?: number;
}

export type DocTransform = (doc: CircuitDocument) => CircuitDocument;

export class EditorHistory {
  private undoStack: CircuitDocument[] = [];
  private redoStack: CircuitDocument[] = [];
  private doc: CircuitDocument;
  private readonly maxDepth: number;

  constructor(initial: CircuitDocument, opts: HistoryOptions = {}) {
    this.doc = initial;
    this.maxDepth = opts.maxDepth ?? 100;
  }

  get current(): CircuitDocument {
    return this.doc;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Apply a pure transform (typically a commands.ts function). Records the prior state for undo and
   * clears the redo stack. A transform that returns the SAME reference is a no-op (nothing recorded).
   */
  apply(fn: DocTransform): CircuitDocument {
    const next = fn(this.doc);
    if (next === this.doc) return this.doc;
    this.pushUndo(this.doc);
    this.redoStack = [];
    this.doc = next;
    return next;
  }

  undo(): CircuitDocument {
    const prev = this.undoStack.pop();
    if (prev === undefined) return this.doc;
    this.redoStack.push(this.doc);
    this.doc = prev;
    return prev;
  }

  redo(): CircuitDocument {
    const next = this.redoStack.pop();
    if (next === undefined) return this.doc;
    this.undoStack.push(this.doc);
    this.doc = next;
    return next;
  }

  /** Replace the document outright (last-write-wins sync); undoable, clears redo. */
  replace(doc: CircuitDocument): void {
    if (doc === this.doc) return;
    this.pushUndo(this.doc);
    this.redoStack = [];
    this.doc = doc;
  }

  private pushUndo(doc: CircuitDocument): void {
    this.undoStack.push(doc);
    if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
  }
}
