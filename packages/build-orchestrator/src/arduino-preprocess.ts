/**
 * Arduino sketch preprocessing — REFERENCE-SPEC Stage 2 / §17.
 *
 * Turns a set of `.ino` files into a single compilable `.cpp`:
 *   1. concatenate `.ino` files (main first, then the rest alphabetically),
 *   2. inject `#include <Arduino.h>` if absent,
 *   3. generate forward prototypes for top-level functions (so a sketch can call
 *      a function defined later — the Arduino "magic"),
 *   4. emit `#line` directives so compiler diagnostics map back to the right file.
 *
 * The prototype generation is heuristic (not a full C++ parser) — enough for the
 * common sketches the gate uses; complex templates/macros may need manual decls.
 */

import { scrubComments } from './scrub.js';

export interface InoFile {
  name: string;
  content: string;
}

export interface PreprocessResult {
  cpp: string;
  /** Generated prototypes, in order (for diagnostics/debugging). */
  prototypes: string[];
}

const FUNC_DEF_RE =
  /^[ \t]*((?:[A-Za-z_][\w:<>,*& \t]*?))[ \t]+([A-Za-z_]\w*)[ \t]*\(([^;{)]*)\)[ \t]*\{/;

const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'else',
  'do',
  'return',
  'sizeof',
]);

/** Order .ino files: the main sketch (matching folder/main) first, rest sorted. */
function orderInoFiles(files: InoFile[], mainName?: string): InoFile[] {
  const main = mainName ? files.find((f) => f.name === mainName) : undefined;
  const rest = files.filter((f) => f !== main).sort((a, b) => a.name.localeCompare(b.name));
  return main ? [main, ...rest] : rest;
}

/** Heuristic: collect forward declarations for top-level function definitions. */
function generatePrototypes(source: string): string[] {
  const protos: string[] = [];
  const seen = new Set<string>();
  // Scan a comment-scrubbed copy so code inside comments is ignored. Strings are kept
  // (the ^-anchored regex already prevents string-embedded text from false-matching).
  for (const line of scrubComments(source).split('\n')) {
    const m = line.match(FUNC_DEF_RE);
    if (!m) continue;
    const returnType = m[1]!.trim();
    const name = m[2]!;
    const params = m[3]!.trim();
    if (CONTROL_KEYWORDS.has(name) || CONTROL_KEYWORDS.has(returnType)) continue;
    if (returnType === '') continue;
    const proto = `${returnType} ${name}(${params});`;
    if (!seen.has(proto)) {
      seen.add(proto);
      protos.push(proto);
    }
  }
  return protos;
}

export function preprocessSketch(files: InoFile[], mainName?: string): PreprocessResult {
  const ordered = orderInoFiles(files, mainName);

  // Concatenate with #line directives for faithful diagnostics.
  const bodyParts: string[] = [];
  for (const f of ordered) {
    bodyParts.push(`#line 1 "${f.name}"`);
    bodyParts.push(f.content.replace(/\n$/, ''));
  }
  const body = bodyParts.join('\n');

  const hasArduinoInclude = /#\s*include\s*[<"]Arduino\.h[>"]/.test(body);
  const prototypes = generatePrototypes(body);

  const header: string[] = [];
  if (!hasArduinoInclude) header.push('#include <Arduino.h>');
  if (prototypes.length) {
    header.push('#line 1 "sketch.prototypes"');
    header.push(...prototypes);
  }

  const cpp = (header.length ? header.join('\n') + '\n' : '') + body + '\n';
  return { cpp, prototypes };
}
