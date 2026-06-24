import { describe, it, expect } from 'vitest';
import { preprocessSketch } from './arduino-preprocess.js';

describe('arduino preprocess', () => {
  it('injects #include <Arduino.h> when missing and adds #line directives', () => {
    const { cpp } = preprocessSketch([
      { name: 'Blink.ino', content: 'void setup(){}\nvoid loop(){}' },
    ]);
    expect(cpp).toContain('#include <Arduino.h>');
    expect(cpp).toContain('#line 1 "Blink.ino"');
  });

  it('does not double-add Arduino.h when already present', () => {
    const { cpp } = preprocessSketch([
      { name: 'S.ino', content: '#include <Arduino.h>\nvoid setup(){}\nvoid loop(){}' },
    ]);
    expect(cpp.match(/#include <Arduino\.h>/g)?.length).toBe(1);
  });

  it('generates forward prototypes so functions can be used before definition', () => {
    const sketch = `void setup(){ blink(3); }
void loop(){}
void blink(int n){ for(int i=0;i<n;i++){} }`;
    const { cpp, prototypes } = preprocessSketch([{ name: 'a.ino', content: sketch }]);
    expect(prototypes).toContain('void blink(int n);');
    // Prototype appears before the call site (blink(3) inside setup) and the body.
    expect(cpp.indexOf('void blink(int n);')).toBeLessThan(cpp.indexOf('blink(3)'));
  });

  it('does not mistake control statements for function definitions', () => {
    const sketch = `void loop(){\n  if (digitalRead(2)) {\n  }\n  for (int i=0;i<3;i++) {\n  }\n}`;
    const { prototypes } = preprocessSketch([{ name: 'a.ino', content: sketch }]);
    expect(prototypes.some((p) => /\b(if|for)\b/.test(p))).toBe(false);
  });

  it('does NOT generate prototypes for functions inside block comments (bug regression)', () => {
    const sketch = `void setup(){}
/*
void ghostInComment(int x){
*/
void real(){}`;
    const { prototypes } = preprocessSketch([{ name: 'a.ino', content: sketch }]);
    expect(prototypes.some((p) => /ghostInComment/.test(p))).toBe(false);
    expect(prototypes).toContain('void real();');
  });

  it('does NOT generate prototypes for function-like text inside strings', () => {
    const sketch = `const char* s = "void ghostInString(){}";
void real(){}`;
    const { prototypes } = preprocessSketch([{ name: 'a.ino', content: sketch }]);
    expect(prototypes.some((p) => /ghostInString/.test(p))).toBe(false);
  });

  it('handles an empty source file: injects Arduino.h, no prototypes, valid #line', () => {
    const { cpp, prototypes } = preprocessSketch([{ name: 'Empty.ino', content: '' }]);
    expect(prototypes).toHaveLength(0);
    expect(cpp).toContain('#include <Arduino.h>');
    expect(cpp).toContain('#line 1 "Empty.ino"');
    // No prototypes block when there are no functions.
    expect(cpp).not.toContain('sketch.prototypes');
  });

  it('orders the main .ino first, then others alphabetically', () => {
    const { cpp } = preprocessSketch(
      [
        { name: 'b_tab.ino', content: 'int helperB(){return 2;}' },
        { name: 'Main.ino', content: 'void setup(){}\nvoid loop(){}' },
        { name: 'a_tab.ino', content: 'int helperA(){return 1;}' },
      ],
      'Main.ino',
    );
    expect(cpp.indexOf('Main.ino')).toBeLessThan(cpp.indexOf('a_tab.ino'));
    expect(cpp.indexOf('a_tab.ino')).toBeLessThan(cpp.indexOf('b_tab.ino'));
  });
});
