/**
 * Geometry — pure helpers the canvas UI consumes for drawing + interaction: world pin positions
 * (rotation-aware), component bounding boxes, grid snapping, and pin/component hit-testing. No DOM:
 * the caller owns rendering. Rotation is around the part's centre, in exact 90° steps, so positions
 * stay integer-exact (no float drift) and reproducible.
 */
import type {
  BoardPlacement,
  CircuitDocument,
  PinRef,
  PinType,
  PlacedComponent,
  Point,
  Rotation,
} from './types.js';
import { MCU_REF } from './types.js';
import { catalogEntry } from './catalog.js';
import { boardEntry } from './board.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const COS: Record<Rotation, number> = { 0: 1, 90: 0, 180: -1, 270: 0 };
const SIN: Record<Rotation, number> = { 0: 0, 90: 1, 180: 0, 270: -1 };

/** Rotate `p` by an exact 90° step around centre `c`. */
export function rotateAround(p: Point, deg: Rotation, c: Point): Point {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const cos = COS[deg];
  const sin = SIN[deg];
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** World position of a placed component's named pin (origin + rotation applied), or undefined. */
export function pinWorldPosition(comp: PlacedComponent, pinName: string): Point | undefined {
  const entry = catalogEntry(comp.type);
  const pin = entry?.pins.find((p) => p.name === pinName);
  if (!entry || !pin) return undefined;
  const r = rotateAround({ x: pin.x, y: pin.y }, comp.rotation, {
    x: entry.size.w / 2,
    y: entry.size.h / 2,
  });
  return { x: comp.x + r.x, y: comp.y + r.y };
}

/** World position of a board MCU pin, or undefined. */
export function boardPinWorldPosition(board: BoardPlacement, pinName: string): Point | undefined {
  const entry = boardEntry(board.id);
  const pin = entry?.pins.find((p) => p.name === pinName);
  if (!entry || !pin) return undefined;
  const r = rotateAround({ x: pin.x, y: pin.y }, board.rotation, {
    x: entry.size.w / 2,
    y: entry.size.h / 2,
  });
  return { x: board.x + r.x, y: board.y + r.y };
}

/** World position of any pin addressed by a PinRef (board or component). */
export function pinRefWorldPosition(doc: CircuitDocument, ref: PinRef): Point | undefined {
  if (ref.component === MCU_REF) return boardPinWorldPosition(doc.board, ref.pin);
  const comp = doc.components.find((c) => c.id === ref.component);
  return comp ? pinWorldPosition(comp, ref.pin) : undefined;
}

/** Axis-aligned bounding box of a placed component in world space (rotation applied). */
export function componentBounds(comp: PlacedComponent): Rect {
  const entry = catalogEntry(comp.type);
  if (!entry) return { x: comp.x, y: comp.y, w: 0, h: 0 };
  const c = { x: entry.size.w / 2, y: entry.size.h / 2 };
  const corners = [
    { x: 0, y: 0 },
    { x: entry.size.w, y: 0 },
    { x: entry.size.w, y: entry.size.h },
    { x: 0, y: entry.size.h },
  ].map((p) => rotateAround(p, comp.rotation, c));
  const xs = corners.map((p) => comp.x + p.x);
  const ys = corners.map((p) => comp.y + p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Snap a point to a grid of `grid` units (default 8). */
export function snapToGrid(p: Point, grid = 8): Point {
  return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid };
}

export interface PinHandle {
  ref: PinRef;
  point: Point;
  type: PinType;
}

/** Every pin in the document (board + components) with its world position — for rendering handles. */
export function allPinHandles(doc: CircuitDocument): PinHandle[] {
  const out: PinHandle[] = [];
  const board = boardEntry(doc.board.id);
  if (board) {
    for (const p of board.pins) {
      const point = boardPinWorldPosition(doc.board, p.name);
      if (point) out.push({ ref: { component: MCU_REF, pin: p.name }, point, type: p.type });
    }
  }
  for (const comp of doc.components) {
    const entry = catalogEntry(comp.type);
    if (!entry) continue;
    for (const p of entry.pins) {
      const point = pinWorldPosition(comp, p.name);
      if (point) out.push({ ref: { component: comp.id, pin: p.name }, point, type: p.type });
    }
  }
  return out;
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Nearest pin within `radius` of a world point (for click-to-connect), or undefined. */
export function hitTestPin(doc: CircuitDocument, world: Point, radius = 6): PinRef | undefined {
  const r2 = radius * radius;
  let best: PinRef | undefined;
  let bestD = Infinity;
  for (const h of allPinHandles(doc)) {
    const d = dist2(world, h.point);
    if (d <= r2 && d < bestD) {
      bestD = d;
      best = h.ref;
    }
  }
  return best;
}

/** Topmost component whose bounds contain the point (later in the array = drawn on top). */
export function hitTestComponent(doc: CircuitDocument, world: Point): string | undefined {
  for (let i = doc.components.length - 1; i >= 0; i--) {
    const comp = doc.components[i]!;
    if (rectContains(componentBounds(comp), world)) return comp.id;
  }
  return undefined;
}
