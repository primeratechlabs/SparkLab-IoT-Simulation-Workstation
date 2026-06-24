/**
 * Stage 7 — beginner error translator. clang/gcc/linker diagnostics are terse and scary for
 * learners ("undefined reference to `loop'"). This maps the common ones to a plain-language
 * `friendly` explanation (the field on Diagnostic), without hiding the original message. Pure
 * pattern-matching — no I/O — so it's deterministic and unit-tested.
 */
import type { Diagnostic } from '@sparklab/shared';

interface Rule {
  test: RegExp;
  friendly: (m: RegExpMatchArray) => string;
}

const RULES: Rule[] = [
  {
    // matches "expected ';'" and gcc's "expected ',' or ';' before '}' token"
    test: /expected (?:'[^']*' or )*';'/i,
    friendly: () =>
      'Missing a semicolon `;` — every statement in C/C++ ends with one. Check this line and the line above it.',
  },
  {
    test: /expected '}'|expected '\)'|expected '{'/i,
    friendly: () =>
      'A bracket is missing or unmatched — make sure every `(`, `{` has a matching `)`, `}`.',
  },
  {
    test: /use of undeclared identifier '([^']+)'|'([^']+)' was not declared in this scope/i,
    friendly: (m) =>
      `'${m[1] ?? m[2]}' isn't declared yet — check the spelling, define it first, or add the #include that provides it.`,
  },
  {
    test: /'?([\w./-]+\.h)'? file not found|fatal error: ([\w./-]+\.h): No such file/i,
    friendly: (m) =>
      `The library header "${m[1] ?? m[2]}" wasn't found — install that library or fix the #include name.`,
  },
  {
    test: /undefined reference to [`']?([^'`]+)[`']?|undefined symbol:?\s*(\S+)/i,
    friendly: (m) =>
      `Linker error: "${(m[1] ?? m[2] ?? '').trim()}" is used but never defined — you're likely missing a library or a function body (e.g. setup()/loop()).`,
  },
  {
    // e.g. "duplicate symbol: Blynk" — usually a library installed on top of one the simulator already
    // provides (Blynk/WiFi). Most commonly the real Blynk library vs the simulator's built-in HTTP Blynk.
    test: /duplicate symbol:?\s*[`']?([^'`\s]+)/i,
    friendly: (m) =>
      `"${m[1]}" is defined twice — usually because you installed a library that the simulator already provides built-in (e.g. Blynk or WiFi). Remove the extra library in the Library tab; the built-in #include keeps working.`,
  },
  {
    test: /redefinition of '([^']+)'|'([^']+)' redefined/i,
    friendly: (m) =>
      `"${m[1] ?? m[2]}" is defined more than once — remove the duplicate definition or #include.`,
  },
  {
    test: /region [`']?\w+[`']? overflowed|will not fit in region|section .* overflowed|text section exceeds/i,
    friendly: () =>
      "The program is too big for the board's flash — reduce code or library size, or pick a board with more memory.",
  },
  {
    test: /'([^']+)' does not name a type/i,
    friendly: (m) =>
      `"${m[1]}" isn't a known type here — you probably need an #include, or there's a typo.`,
  },
  {
    test: /too few arguments to function|too many arguments to function|no matching function for call/i,
    friendly: () =>
      "A function is called with the wrong number/type of arguments — check how it's defined.",
  },
  {
    test: /invalid conversion from|cannot convert|incompatible types/i,
    friendly: () =>
      "A value has the wrong type for where it's used — check the variable types (e.g. int vs String).",
  },
  {
    test: /control reaches end of non-void function/i,
    friendly: () =>
      'A function that should return a value can finish without returning one — add a `return`.',
  },
];

/** Plain-language explanation for a raw compiler/linker message, or undefined if none matches. */
export function friendlyFor(message: string): string | undefined {
  for (const r of RULES) {
    const m = message.match(r.test);
    if (m) return r.friendly(m);
  }
  return undefined;
}

/** Attach a `friendly` explanation to a diagnostic (no-op if it already has one or none matches). */
export function translateDiagnostic(d: Diagnostic): Diagnostic {
  if (d.friendly) return d;
  const f = friendlyFor(d.message);
  return f ? { ...d, friendly: f } : d;
}

export function translateDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return ds.map(translateDiagnostic);
}
