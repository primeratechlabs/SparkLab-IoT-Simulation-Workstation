/**
 * Blank out C/C++ comments and string/char literals while preserving line structure
 * (newlines and length per line). Used before line-based scanning (prototype
 * detection, #include detection) so code that only *appears* inside a comment or
 * string is never mistaken for real source.
 */
function scrub(src: string, blankStrings: boolean): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type State = 'normal' | 'line' | 'block' | 'str' | 'char';
  let state: State = 'normal';

  const blank = (c: string) => (c === '\n' ? '\n' : c === '\t' ? '\t' : ' ');
  // In string/char state we always TRACK (so `//` inside a string isn't a comment),
  // but only BLANK the content when blankStrings is set; otherwise copy it verbatim.
  const emit = (c: string) => (blankStrings ? blank(c) : c);

  while (i < n) {
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1]! : '';
    switch (state) {
      case 'normal':
        if (c === '/' && c2 === '/') {
          state = 'line';
          out += '  ';
          i += 2;
        } else if (c === '/' && c2 === '*') {
          state = 'block';
          out += '  ';
          i += 2;
        } else if (c === '"') {
          state = 'str';
          out += emit('"');
          i += 1;
        } else if (c === "'") {
          state = 'char';
          out += emit("'");
          i += 1;
        } else {
          out += c;
          i += 1;
        }
        break;
      case 'line':
        if (c === '\n') {
          state = 'normal';
          out += '\n';
        } else {
          out += blank(c);
        }
        i += 1;
        break;
      case 'block':
        if (c === '*' && c2 === '/') {
          state = 'normal';
          out += '  ';
          i += 2;
        } else {
          out += blank(c);
          i += 1;
        }
        break;
      case 'str':
        if (c === '\\' && i + 1 < n) {
          // Escape: consume backslash + the escaped char together. Guard against a
          // trailing backslash at EOF (c2 === '') so we don't emit a phantom char or
          // advance past the end while stuck in 'str'.
          out += emit('\\') + emit(c2);
          i += 2;
        } else if (c === '"') {
          state = 'normal';
          out += emit('"');
          i += 1;
        } else {
          out += emit(c);
          i += 1;
        }
        break;
      case 'char':
        if (c === '\\' && i + 1 < n) {
          // Same escape handling as 'str': guard a trailing backslash at EOF.
          out += emit('\\') + emit(c2);
          i += 2;
        } else if (c === "'") {
          state = 'normal';
          out += emit("'");
          i += 1;
        } else {
          out += emit(c);
          i += 1;
        }
        break;
    }
  }
  return out;
}

/** Blank comments only; string/char literals are preserved verbatim. */
export function scrubComments(src: string): string {
  return scrub(src, false);
}

/** Blank both comments AND string/char literal contents. */
export function scrubCommentsAndStrings(src: string): string {
  return scrub(src, true);
}
