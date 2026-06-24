import { describe, it, expect } from 'vitest';
import { friendlyFor, translateDiagnostic, translateDiagnostics } from './error-translator.js';
import type { Diagnostic } from '@sparklab/shared';

describe('error-translator — friendlyFor', () => {
  it('explains the common beginner compiler/linker errors', () => {
    expect(friendlyFor("error: expected ';' before 'digitalWrite'")).toMatch(/semicolon/i);
    expect(friendlyFor("sketch.ino:1: expected ',' or ';' before '}' token")).toMatch(/semicolon/i); // gcc phrasing
    expect(friendlyFor("error: use of undeclared identifier 'ledPin'")).toContain('ledPin');
    expect(friendlyFor("'sensorValue' was not declared in this scope")).toContain('sensorValue');
    expect(friendlyFor('fatal error: DHT.h: No such file or directory')).toMatch(/library/i);
    expect(friendlyFor("'WiFi.h' file not found")).toContain('WiFi.h');
    expect(friendlyFor("undefined reference to `loop'")).toMatch(/Linker/i);
    expect(friendlyFor('ld: undefined symbol: _Z4loopv')).toMatch(/Linker/i);
    // curriculum HC-SR04 pulseIn(): the AVR core's wiring_pulse.S must link, else this is the user-facing error
    expect(friendlyFor("undefined reference to `countPulseASM'")).toMatch(/Linker.*countPulseASM/i);
    // a library installed on top of a built-in one (the real Blynk lib vs the simulator's HTTP Blynk)
    expect(friendlyFor('this.program: error: duplicate symbol: Blynk')).toMatch(
      /defined twice.*Library/i,
    );
    expect(friendlyFor("region `text' overflowed by 1024 bytes")).toMatch(/too big|flash/i);
    expect(friendlyFor("'Servo' does not name a type")).toContain('Servo');
    expect(friendlyFor("error: cannot convert 'String' to 'int'")).toMatch(/wrong type/i);
  });

  it('returns undefined for an unrecognised message', () => {
    expect(friendlyFor('some internal compiler note nobody maps')).toBeUndefined();
  });
});

describe('error-translator — translateDiagnostic', () => {
  const base: Diagnostic = {
    severity: 'error',
    file: 'sketch.ino',
    line: 5,
    message: "expected ';' before '}' token",
  };

  it('attaches a friendly explanation, preserving the original', () => {
    const out = translateDiagnostic(base);
    expect(out.message).toBe(base.message); // original untouched
    expect(out.friendly).toMatch(/semicolon/i);
  });

  it('does not overwrite an existing friendly message', () => {
    const out = translateDiagnostic({ ...base, friendly: 'custom' });
    expect(out.friendly).toBe('custom');
  });

  it('leaves an unrecognised diagnostic unchanged (no friendly)', () => {
    const d: Diagnostic = { severity: 'warning', file: 'x', line: 1, message: 'unmapped wording' };
    expect(translateDiagnostic(d).friendly).toBeUndefined();
  });

  it('translateDiagnostics maps a list', () => {
    const out = translateDiagnostics([
      base,
      { severity: 'note', file: 'x', line: 1, message: 'nothing' },
    ]);
    expect(out[0]!.friendly).toBeDefined();
    expect(out[1]!.friendly).toBeUndefined();
  });
});
