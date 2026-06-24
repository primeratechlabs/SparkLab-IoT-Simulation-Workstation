// format-code.ts — self-contained, dependency-free Arduino/C++ code formatter.
//
// This is a *brace-depth reindenter*, NOT an AST pretty-printer. It rescans the
// source character-by-character, tracking string / char / comment / preprocessor
// state so that braces and quotes living inside those contexts never move the
// indentation counter. Then it re-emits every line at `depth * indent`.
//
// Why a scanner and not clang-format/prettier: the app-shell CSP forbids any
// third-party / CDN script, and we want zero runtime deps. A deterministic
// depth counter is good enough for `.ino` sketches and is idempotent by design.

export function formatArduino(source: string, opts?: { indent?: string }): string {
  const indent = opts?.indent ?? '  '; // default: two spaces
  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');

  // Scanner state that must persist ACROSS lines (block comments span lines).
  let depth = 0; // current nesting level (braces only)
  let inBlockComment = false;

  const out: string[] = [];
  let pendingBlank = false; // collapse runs of blank lines into one

  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/, ''); // trim trailing whitespace
    const trimmed = line.trim();

    // Blank line: remember it, but emit at most one between real lines.
    if (trimmed === '') {
      pendingBlank = true;
      continue;
    }

    // Scan this line to compute (a) how its FIRST token affects its own indent
    // (a leading closer dedents the line itself) and (b) the net brace delta the
    // line leaves behind for following lines.
    const scan = scanLine(trimmed, inBlockComment);
    inBlockComment = scan.endsInBlockComment;

    // Preprocessor directives (#include / #define / #ifdef ...) go to column 0 —
    // the common Arduino convention. They do not participate in brace depth and
    // their inner text is left untouched (scanLine ignores their content).
    let renderDepth: number;
    if (scan.isPreprocessor) {
      renderDepth = 0;
    } else {
      // A line that STARTS with a closer (`}`, `)`, `]`) or is a `case`/`default`
      // label dedents itself by one before rendering. `leadingDedent` counts how
      // many levels to drop for this line only (e.g. `}` or `};` or `})`).
      renderDepth = Math.max(0, depth - scan.leadingDedent);
    }

    // Flush a single pending blank line (never at the very top of the file).
    if (pendingBlank && out.length > 0) out.push('');
    pendingBlank = false;

    out.push(renderDepth > 0 ? indent.repeat(renderDepth) + trimmed : trimmed);

    // Apply the line's net brace delta for SUBSEQUENT lines.
    depth = Math.max(0, depth + scan.netDelta);
  }

  // Ensure exactly one trailing newline.
  return out.join('\n').replace(/\n*$/, '') + '\n';
}

interface LineScan {
  isPreprocessor: boolean;
  leadingDedent: number; // levels this line removes from its OWN indent
  netDelta: number; // brace depth change left for following lines
  endsInBlockComment: boolean;
}

// Scan a single (already trimmed) line, honouring string / char / line-comment /
// block-comment state so that braces inside them are ignored.
function scanLine(trimmed: string, startInBlockComment: boolean): LineScan {
  // Preprocessor lines: leave content untouched, no brace accounting. (A line
  // continuation `\` could spill a #define onto the next line, but we keep it
  // simple — rare in sketches and harmless to re-indent.)
  if (!startInBlockComment && trimmed.startsWith('#')) {
    return { isPreprocessor: true, leadingDedent: 0, netDelta: 0, endsInBlockComment: false };
  }

  let inBlock = startInBlockComment;
  let inString = false; // "..."
  let inChar = false; //  '...'
  let net = 0; // running brace depth within the line
  let firstSignificantIsCloser = false;
  let seenSignificant = false;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!; // i < length → always defined
    const next = trimmed[i + 1];

    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\')
        i++; // skip escaped char
      else if (c === '"') inString = false;
      continue;
    }
    if (inChar) {
      if (c === '\\') i++;
      else if (c === "'") inChar = false;
      continue;
    }

    // Not inside any literal/comment: detect openers of those contexts first.
    if (c === '/' && next === '/') break; // rest of line is a line comment
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      markSignificant(c);
      continue;
    }
    if (c === "'") {
      inChar = true;
      markSignificant(c);
      continue;
    }

    if (c === '{' || c === '(' || c === '[') {
      markSignificant(c);
      net++;
    } else if (c === '}' || c === ')' || c === ']') {
      markSignificant(c);
      net--;
    } else if (!/\s/.test(c)) {
      markSignificant(c);
    }
  }

  function markSignificant(c: string): void {
    if (!seenSignificant) {
      seenSignificant = true;
      firstSignificantIsCloser = c === '}' || c === ')' || c === ']';
    }
  }

  // The line dedents itself if it opens with a closer (`}`, `};`, `})`, ...).
  // `case`/`default:` labels also sit one level out from the switch body, so we
  // treat them as a one-level dedent for their own line (kept deliberately simple).
  const isCaseLabel = /^(case\b.*:|default\s*:)/.test(trimmed);
  const leadingDedent = firstSignificantIsCloser || isCaseLabel ? 1 : 0;

  return { isPreprocessor: false, leadingDedent, netDelta: net, endsInBlockComment: inBlock };
}
