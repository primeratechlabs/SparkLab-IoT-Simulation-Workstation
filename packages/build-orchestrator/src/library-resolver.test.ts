import { describe, it, expect } from 'vitest';
import { resolveLibraries, type LibraryCatalogEntry } from './library-resolver.js';

const catalog: LibraryCatalogEntry[] = [
  {
    name: 'DHT sensor library',
    version: '1.4.6',
    provides: ['DHT.h', 'DHT_U.h'],
    architectures: ['avr', 'esp32'],
    depends: [{ name: 'Adafruit Unified Sensor' }],
    srcDir: '/lib/DHT/src',
    headers: ['DHT.h'],
  },
  {
    name: 'Adafruit Unified Sensor',
    version: '1.1.14',
    provides: ['Adafruit_Sensor.h'],
    architectures: ['*'],
    srcDir: '/lib/Adafruit_Sensor/src',
    headers: ['Adafruit_Sensor.h'],
  },
  {
    name: 'LiquidCrystal_I2C',
    version: '1.1.4',
    provides: ['LiquidCrystal_I2C.h'],
    architectures: ['avr'],
    srcDir: '/lib/LiquidCrystal_I2C/src',
    headers: ['LiquidCrystal_I2C.h'],
  },
  {
    name: 'WiFiEsp32Only',
    version: '1.0.0',
    provides: ['WiFiX.h'],
    architectures: ['esp32'],
    srcDir: '/lib/wifi/src',
    headers: ['WiFiX.h'],
  },
];

describe('resolveLibraries', () => {
  it('resolves includes and pulls transitive depends', () => {
    const { libraries, unresolved } = resolveLibraries({
      includes: ['DHT.h', 'LiquidCrystal_I2C.h', 'Arduino.h'],
      catalog,
      architecture: 'avr',
    });
    const names = libraries.map((l) => l.name);
    expect(names).toContain('DHT sensor library');
    expect(names).toContain('Adafruit Unified Sensor'); // transitive dep of DHT
    expect(names).toContain('LiquidCrystal_I2C');
    expect(unresolved).toContain('Arduino.h'); // not in the library catalog
  });

  it('filters by architecture', () => {
    const { libraries, unresolved } = resolveLibraries({
      includes: ['WiFiX.h'],
      catalog,
      architecture: 'avr',
    });
    expect(libraries).toHaveLength(0);
    expect(unresolved).toContain('WiFiX.h');
  });

  it('terminates on a dependency cycle (A↔B) without infinite loop', () => {
    const cyc: LibraryCatalogEntry[] = [
      {
        name: 'A',
        version: '1',
        provides: ['A.h'],
        architectures: ['avr'],
        depends: [{ name: 'B' }],
        srcDir: '/a',
        headers: ['A.h'],
      },
      {
        name: 'B',
        version: '1',
        provides: ['B.h'],
        architectures: ['avr'],
        depends: [{ name: 'A' }],
        srcDir: '/b',
        headers: ['B.h'],
      },
    ];
    const r = resolveLibraries({ includes: ['A.h'], catalog: cyc, architecture: 'avr' });
    expect(r.libraries.map((l) => l.name).sort()).toEqual(['A', 'B']);
  });

  it('tolerates a missing dependency (no crash, resolves what it can)', () => {
    const cat: LibraryCatalogEntry[] = [
      {
        name: 'X',
        version: '1',
        provides: ['X.h'],
        architectures: ['avr'],
        depends: [{ name: 'NoSuch' }],
        srcDir: '/x',
        headers: ['X.h'],
      },
    ];
    const r = resolveLibraries({ includes: ['X.h'], catalog: cat, architecture: 'avr' });
    expect(r.libraries.map((l) => l.name)).toEqual(['X']);
  });

  it('prefers a library whose name matches the header (priority)', () => {
    const withDup: LibraryCatalogEntry[] = [
      ...catalog,
      {
        name: 'Generic',
        version: '0.1.0',
        provides: ['LiquidCrystal_I2C.h'],
        architectures: ['avr'],
        srcDir: '/lib/generic/src',
        headers: ['LiquidCrystal_I2C.h'],
      },
    ];
    const { libraries } = resolveLibraries({
      includes: ['LiquidCrystal_I2C.h'],
      catalog: withDup,
      architecture: 'avr',
    });
    expect(libraries.map((l) => l.name)).toContain('LiquidCrystal_I2C');
    expect(libraries.map((l) => l.name)).not.toContain('Generic');
  });
});
