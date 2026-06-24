/**
 * Single-producer / single-consumer lock-free ring buffer over a SharedArrayBuffer —
 * the hot-path transport (REFERENCE-SPEC §31). The sim Worker pushes binary event
 * frames; the workbench/render Worker pops them, with no locks and no main-thread
 * involvement (invariant I2). Head/tail live in an Int32 control region updated with
 * Atomics so writes publish-then-become-visible across Workers; the data region is a
 * fixed grid of slots, each holding one length-prefixed frame.
 */

import { encodeFrame, decodeFrame, type FrameHeader } from './binary-frame.js';

const HEAD = 0;
const TAIL = 1;
const CTRL_BYTES = 8; // two Int32

export class SabRing {
  private readonly ctrl: Int32Array;
  private readonly data: DataView;
  private readonly bytes: Uint8Array;

  constructor(
    readonly sab: SharedArrayBuffer,
    private readonly slotCount: number,
    private readonly slotBytes: number,
  ) {
    if (!Number.isInteger(slotCount) || slotCount < 2)
      throw new Error('slotCount must be an integer >= 2');
    if (!Number.isInteger(slotBytes)) throw new Error('slotBytes must be an integer');
    if (slotBytes <= 4) throw new Error('slotBytes must exceed the 4-byte length prefix');
    if (sab.byteLength < CTRL_BYTES + slotCount * slotBytes)
      throw new Error('SharedArrayBuffer too small for ring');
    this.ctrl = new Int32Array(sab, 0, 2);
    this.data = new DataView(sab, CTRL_BYTES);
    this.bytes = new Uint8Array(sab, CTRL_BYTES);
  }

  /** Allocate a fresh ring (producer side); the consumer reattaches with `attach`. */
  static create(slotCount = 1024, slotBytes = 64): SabRing {
    return new SabRing(
      new SharedArrayBuffer(CTRL_BYTES + slotCount * slotBytes),
      slotCount,
      slotBytes,
    );
  }

  /** Reattach to an existing ring's SharedArrayBuffer (consumer side / other Worker). */
  static attach(sab: SharedArrayBuffer, slotCount: number, slotBytes: number): SabRing {
    return new SabRing(sab, slotCount, slotBytes);
  }

  get capacity(): number {
    return this.slotCount - 1; // one slot kept empty to disambiguate full vs empty
  }

  /** Live frame count (best-effort snapshot). */
  get size(): number {
    const h = Atomics.load(this.ctrl, HEAD);
    const t = Atomics.load(this.ctrl, TAIL);
    return (t - h + this.slotCount) % this.slotCount;
  }

  /** Push one frame's bytes. Returns false if the ring is full (caller sheds load, I9). */
  push(frame: Uint8Array): boolean {
    if (frame.length > this.slotBytes - 4)
      throw new Error(`frame ${frame.length}B exceeds slot ${this.slotBytes - 4}B`);
    const t = Atomics.load(this.ctrl, TAIL);
    const next = (t + 1) % this.slotCount;
    if (next === Atomics.load(this.ctrl, HEAD)) return false; // full
    const off = t * this.slotBytes;
    this.data.setUint32(off, frame.length, true);
    this.bytes.set(frame, off + 4);
    Atomics.store(this.ctrl, TAIL, next); // publish
    return true;
  }

  /** Pop one frame's bytes (a copy), or null if empty. */
  pop(): Uint8Array | null {
    const h = Atomics.load(this.ctrl, HEAD);
    if (h === Atomics.load(this.ctrl, TAIL)) return null; // empty
    const off = h * this.slotBytes;
    const len = this.data.getUint32(off, true);
    if (len > this.slotBytes - 4) {
      Atomics.store(this.ctrl, HEAD, (h + 1) % this.slotCount);
      throw new Error(`corrupt ring slot length ${len} exceeds ${this.slotBytes - 4}`);
    }
    const out = this.bytes.slice(off + 4, off + 4 + len);
    Atomics.store(this.ctrl, HEAD, (h + 1) % this.slotCount);
    return out;
  }

  /** Encode + push a BridgeEvent frame. */
  pushFrame(timestamp: bigint, eventType: number, busOrPin: number, payload?: Uint8Array): boolean {
    return this.push(new Uint8Array(encodeFrame(timestamp, eventType, busOrPin, payload)));
  }

  /** Pop + decode a frame, or null if empty. */
  popFrame(): { header: FrameHeader; payload: Uint8Array } | null {
    const raw = this.pop();
    return raw ? decodeFrame(raw.buffer as ArrayBuffer) : null;
  }
}
