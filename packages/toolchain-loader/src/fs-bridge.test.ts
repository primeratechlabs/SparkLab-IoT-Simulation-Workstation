import { describe, it, expect } from 'vitest';
import { SdkMount } from './fs-bridge.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('SdkMount', () => {
  it('resolves a header against a registered include path', () => {
    const mount = new SdkMount();
    mount.registerHeader('/sdk/core', 'Arduino.h', enc.encode('// arduino'));
    const hit = mount.resolve('Arduino.h');
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe('/sdk/core/Arduino.h');
    expect(dec.decode(hit!.bytes)).toBe('// arduino');
  });

  it('resolves across multiple include paths in priority order', () => {
    const mount = new SdkMount();
    // Core registered first → higher priority for same name.
    mount.registerHeader('/sdk/core', 'common.h', enc.encode('core'));
    mount.registerHeader('/sdk/lib/Wire', 'Wire.h', enc.encode('wire'));
    mount.registerHeader('/sdk/lib/Wire', 'common.h', enc.encode('lib'));

    // Name only in the library path resolves there.
    const wire = mount.resolve('Wire.h');
    expect(wire).not.toBeNull();
    expect(wire!.path).toBe('/sdk/lib/Wire/Wire.h');

    // Shadowed name resolves to the first-registered (core) include path.
    const common = mount.resolve('common.h');
    expect(common).not.toBeNull();
    expect(common!.path).toBe('/sdk/core/common.h');
    expect(dec.decode(common!.bytes)).toBe('core');
  });

  it('attaches the library tag when the include path was registered with one', () => {
    const mount = new SdkMount();
    mount.addIncludePath('/sdk/lib/Servo', 'Servo');
    mount.registerHeader('/sdk/lib/Servo', 'Servo.h', enc.encode('servo'));
    const hit = mount.resolve('Servo.h');
    expect(hit!.library).toBe('Servo');
  });

  it('does not collide when paths/names contain spaces (regression)', () => {
    // With a plain-space delimiter, key('/a', 'b c') === key('/a b', 'c') === '/a b c',
    // so the two distinct headers would alias. The NUL delimiter keeps them separate.
    const mount = new SdkMount();
    mount.registerHeader('/a', 'b c.h', enc.encode('first'));
    mount.registerHeader('/a b', 'c.h', enc.encode('second'));

    const first = mount.resolve('b c.h');
    const second = mount.resolve('c.h');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(dec.decode(first!.bytes)).toBe('first');
    expect(dec.decode(second!.bytes)).toBe('second');
    expect(first!.path).toBe('/a/b c.h');
    expect(second!.path).toBe('/a b/c.h');
  });

  it('returns null for an unknown header', () => {
    const mount = new SdkMount();
    mount.registerHeader('/sdk/core', 'Arduino.h', enc.encode('x'));
    expect(mount.resolve('Nope.h')).toBeNull();
  });
});
