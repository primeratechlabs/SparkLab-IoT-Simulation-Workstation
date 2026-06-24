/**
 * Stage 7 — differential testing framework. Two uses:
 *   1. compare a firmware built by the client (wasm) toolchain against a REFERENCE toolchain
 *      (arduino-cli / native gcc) — they should match byte-for-byte for the same source + flags;
 *   2. differential FUZZING — generate random *valid* sketches and build each twice (independent
 *      daemons / toolchains), catching any non-determinism or codegen divergence the few
 *      hand-written sketches would miss.
 *
 * Pure + deterministic (seeded PRNG) so a failing seed reproduces exactly. The actual cross-
 * toolchain run is gated on the reference toolchain being present.
 */

/** mulberry32 — a small, fast, deterministic PRNG so each seed gives a reproducible sketch. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SketchOptions {
  /** Number of body statements (default 4–9, seed-derived). */
  statements?: number;
}

/**
 * Generate a random but VALID Arduino sketch from a seed: a fixed set of OUTPUT pins, then a
 * sequence of well-typed statements (digitalWrite / Serial.println / arithmetic / bounded for /
 * delay). Always compiles; deterministic per seed.
 */
export function randomSketch(seed: number, opts: SketchOptions = {}): string {
  const rnd = mulberry32(seed);
  const ri = (n: number): number => Math.floor(rnd() * n);
  const pick = <T>(arr: readonly T[]): T => arr[ri(arr.length)]!;
  const pins = [2, 3, 4, 5, 13] as const;
  const count = opts.statements ?? 4 + ri(6);

  const setup = ['Serial.begin(9600);', ...pins.map((p) => `pinMode(${p}, OUTPUT);`)];
  const body: string[] = [];
  for (let i = 0; i < count; i++) {
    switch (ri(5)) {
      case 0:
        body.push(`digitalWrite(${pick(pins)}, ${pick(['HIGH', 'LOW'] as const)});`);
        break;
      case 1:
        body.push(`Serial.println(${ri(1000)});`);
        break;
      case 2:
        body.push(`int v${i} = ${ri(256)} + ${ri(256)}; Serial.println(v${i});`);
        break;
      case 3:
        body.push(`for (int k = 0; k < ${1 + ri(5)}; k++) { digitalWrite(${pick(pins)}, k & 1); }`);
        break;
      default:
        body.push(`delay(${1 + ri(10)});`);
    }
  }
  return `void setup(){ ${setup.join(' ')} }\nvoid loop(){ ${body.join(' ')} }\n`;
}

export interface FirmwareDiff {
  identical: boolean;
  /** Byte offset of the first difference, or -1 when identical. */
  firstDiffOffset: number;
  lengthA: number;
  lengthB: number;
}

/** Byte-compare two firmware images (client vs reference, or two independent client builds). */
export function compareFirmware(a: Uint8Array, b: Uint8Array): FirmwareDiff {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i])
      return { identical: false, firstDiffOffset: i, lengthA: a.length, lengthB: b.length };
  }
  if (a.length !== b.length)
    return { identical: false, firstDiffOffset: len, lengthA: a.length, lengthB: b.length };
  return { identical: true, firstDiffOffset: -1, lengthA: a.length, lengthB: b.length };
}

/** Compare two textual outputs (e.g. Intel HEX or a serial transcript). */
export function compareText(a: string, b: string): FirmwareDiff {
  return compareFirmware(new TextEncoder().encode(a), new TextEncoder().encode(b));
}
