import { describe, it, expect } from 'vitest';
import { scrubComments, scrubCommentsAndStrings } from './scrub.js';

describe('scrubComments (keeps strings)', () => {
  it('removes line comments, keeps the code before them', () => {
    const out = scrubComments('int x = 1; // comment\nint y = 2;');
    expect(out).toContain('int x = 1;');
    expect(out).not.toContain('comment');
    expect(out.split('\n')).toHaveLength(2);
  });

  it('removes block comments across lines, preserving line count', () => {
    const out = scrubComments('a\n/* void f(){\n still */ b');
    expect(out.split('\n')).toHaveLength(3);
    expect(out).not.toContain('void f');
    expect(out.trimEnd().endsWith('b')).toBe(true);
  });

  it('PRESERVES the #include "x" form (double quotes are a header name, not a string)', () => {
    expect(scrubComments('#include "Servo.h"')).toContain('Servo.h');
  });

  it('does not treat // inside a string literal as a comment', () => {
    const out = scrubComments('const char* u = "http://x"; int real = 5;');
    expect(out).toContain('int real = 5;');
    expect(out).toContain('http://x');
  });
});

describe('scrubCommentsAndStrings (blanks strings too)', () => {
  it('blanks string literal contents', () => {
    const out = scrubCommentsAndStrings('s = "void f(){}"; int real;');
    expect(out).not.toContain('void f');
    expect(out).toContain('int real;');
  });

  it('handles escaped quotes inside strings', () => {
    const out = scrubCommentsAndStrings('s = "a\\"b"; int real;');
    expect(out).toContain('int real;');
  });

  it('terminates and preserves length on a trailing backslash at EOF in a string (regression)', () => {
    // An unclosed string ending in a lone backslash must not advance past EOF or
    // emit a phantom char — the escape only applies when there IS a next char.
    const src = 's = "abc\\';
    const out = scrubCommentsAndStrings(src);
    expect(out).toHaveLength(src.length);
    expect(out).toBe('s =      '); // '"abc\' blanked to 5 spaces, structure intact
  });

  it('terminates and preserves length on a trailing backslash at EOF in a char literal (regression)', () => {
    const src = "c = 'a\\";
    const out = scrubCommentsAndStrings(src);
    expect(out).toHaveLength(src.length);
    expect(out).toBe('c =    '); // "'a\" blanked to 3 spaces
  });

  it('keeps a trailing backslash verbatim at EOF when not blanking strings', () => {
    const src = 's = "abc\\';
    const out = scrubComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toBe(src);
  });
});
