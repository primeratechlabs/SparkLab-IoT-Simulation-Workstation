import { describe, it, expect } from 'vitest';
import { formatArduino } from './format-code';

describe('formatArduino — brace-depth reindenter', () => {
  it('reindents a messy blink sketch to clean 2-space', () => {
    const messy = [
      'void setup() {',
      'pinMode(LED_BUILTIN, OUTPUT);',
      '}',
      '',
      'void loop() {',
      '        digitalWrite(LED_BUILTIN, HIGH);',
      '   delay(1000);',
      'digitalWrite(LED_BUILTIN, LOW);',
      '             delay(1000);',
      '}',
    ].join('\n');

    expect(formatArduino(messy)).toBe(
      [
        'void setup() {',
        '  pinMode(LED_BUILTIN, OUTPUT);',
        '}',
        '',
        'void loop() {',
        '  digitalWrite(LED_BUILTIN, HIGH);',
        '  delay(1000);',
        '  digitalWrite(LED_BUILTIN, LOW);',
        '  delay(1000);',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('indents nested blocks (if / for / while)', () => {
    const src = [
      'void loop() {',
      'for (int i = 0; i < 10; i++) {',
      'if (i % 2 == 0) {',
      'Serial.println(i);',
      '} else {',
      'while (digitalRead(2)) {',
      'delay(1);',
      '}',
      '}',
      '}',
      '}',
    ].join('\n');

    expect(formatArduino(src)).toBe(
      [
        'void loop() {',
        '  for (int i = 0; i < 10; i++) {',
        '    if (i % 2 == 0) {',
        '      Serial.println(i);',
        '    } else {',
        '      while (digitalRead(2)) {',
        '        delay(1);',
        '      }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('does NOT treat a { inside a string literal as a block opener', () => {
    const src = [
      'void setup() {',
      'Serial.println("{not a block}");',
      'Serial.println("closing } brace");',
      'int x = 1;',
      '}',
    ].join('\n');

    expect(formatArduino(src)).toBe(
      [
        'void setup() {',
        '  Serial.println("{not a block}");',
        '  Serial.println("closing } brace");',
        '  int x = 1;',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('does NOT treat braces inside a char literal as blocks', () => {
    const src = ['void f() {', "char open = '{';", "char close = '}';", 'return;', '}'].join('\n');
    expect(formatArduino(src)).toBe(
      ['void f() {', "  char open = '{';", "  char close = '}';", '  return;', '}', ''].join('\n'),
    );
  });

  it('leaves a line comment containing braces untouched and does not change depth', () => {
    const src = [
      'void setup() {',
      '// this comment has { braces } that should be ignored',
      'int x = 0;',
      '}',
    ].join('\n');

    expect(formatArduino(src)).toBe(
      [
        'void setup() {',
        '  // this comment has { braces } that should be ignored',
        '  int x = 0;',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('leaves block-comment inner text untouched and ignores braces spanning lines', () => {
    const src = [
      'void setup() {',
      '/* a block comment {',
      '   with braces } across lines */',
      'int y = 0;',
      '}',
    ].join('\n');

    expect(formatArduino(src)).toBe(
      [
        'void setup() {',
        '  /* a block comment {',
        '  with braces } across lines */',
        '  int y = 0;',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('keeps #include / #define at column 0 regardless of nesting', () => {
    const src = [
      '#include <Arduino.h>',
      '#define PIN 13',
      'void setup() {',
      '#define INNER 1',
      'pinMode(PIN, OUTPUT);',
      '}',
    ].join('\n');

    expect(formatArduino(src)).toBe(
      [
        '#include <Arduino.h>',
        '#define PIN 13',
        'void setup() {',
        '#define INNER 1',
        '  pinMode(PIN, OUTPUT);',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('handles a switch / case sketch', () => {
    const src = [
      'void handle(int cmd) {',
      'switch (cmd) {',
      'case 0:',
      'doZero();',
      'break;',
      'case 1:',
      'doOne();',
      'break;',
      'default:',
      'doDefault();',
      '}',
      '}',
    ].join('\n');

    const out = formatArduino(src);
    // Simple deterministic rule: `case`/`default` labels dedent one level from
    // the switch body, so they sit at the switch *statement* level, while the
    // statements under them sit one deeper. Assert that consistent shape.
    expect(out).toBe(
      [
        'void handle(int cmd) {',
        '  switch (cmd) {',
        '  case 0:',
        '    doZero();',
        '    break;',
        '  case 1:',
        '    doOne();',
        '    break;',
        '  default:',
        '    doDefault();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('dedents a single `};` (struct / array end) correctly', () => {
    const src = ['struct Point {', 'int x;', 'int y;', '};', 'int a = 1;'].join('\n');
    expect(formatArduino(src)).toBe(
      ['struct Point {', '  int x;', '  int y;', '};', 'int a = 1;', ''].join('\n'),
    );
  });

  it('collapses 2+ consecutive blank lines into at most one', () => {
    const src = ['int a = 1;', '', '', '', 'int b = 2;'].join('\n');
    expect(formatArduino(src)).toBe(['int a = 1;', '', 'int b = 2;', ''].join('\n'));
  });

  it('strips leading/trailing blank lines and trailing whitespace', () => {
    const src = ['', '', 'int a = 1;   ', 'int b = 2;\t', '', ''].join('\n');
    expect(formatArduino(src)).toBe(['int a = 1;', 'int b = 2;', ''].join('\n'));
  });

  it('guarantees exactly one trailing newline', () => {
    expect(formatArduino('int a = 1;')).toBe('int a = 1;\n');
    expect(formatArduino('int a = 1;\n\n\n')).toBe('int a = 1;\n');
    expect(formatArduino('int a = 1;\n').endsWith('\n')).toBe(true);
    expect(formatArduino('int a = 1;\n').endsWith('\n\n')).toBe(false);
  });

  it('is idempotent: format(format(x)) === format(x)', () => {
    const samples = [
      'void setup(){pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}',
      '#include <Arduino.h>\nvoid f(){if(true){Serial.println("{x}");}}',
      'struct S {\nint a;\n};\nvoid g() {\nswitch(x){\ncase 1:\nbreak;\n}\n}',
    ];
    for (const s of samples) {
      const once = formatArduino(s);
      const twice = formatArduino(once);
      expect(twice).toBe(once);
    }
  });

  it('supports a custom indent option', () => {
    const src = ['void f() {', 'int x = 0;', '}'].join('\n');
    expect(formatArduino(src, { indent: '    ' })).toBe(
      ['void f() {', '    int x = 0;', '}', ''].join('\n'),
    );
  });
});
