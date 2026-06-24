import { describe, it, expect } from 'vitest';
import { parseArduinoLibrary } from './arduino-library';
import type { ZipEntry } from './unzip';

const enc = new TextEncoder();
const entry = (name: string, content = ''): ZipEntry => ({ name, bytes: enc.encode(content) });

describe('parseArduinoLibrary', () => {
  it('parses the 1.5 recursive format (library.properties + src/), name/version from properties', () => {
    const lib = parseArduinoLibrary([
      entry('MyLib/library.properties', 'name=My Cool Lib\nversion=1.2.3\n'),
      entry('MyLib/src/MyLib.h', '#pragma once\nint coolize(int);\n'),
      entry('MyLib/src/MyLib.cpp', 'int coolize(int x){ return x+1; }\n'),
      entry('MyLib/src/util/helper.h', 'inline int h(){return 0;}\n'),
      entry('MyLib/examples/Demo/Demo.ino', 'void setup(){} void loop(){}'), // ignored
    ]);
    expect(lib).not.toBeNull();
    expect(lib!.name).toBe('My Cool Lib');
    expect(lib!.version).toBe('1.2.3');
    expect(lib!.provides).toEqual(['MyLib.h']); // top-level header → includable; util/helper.h is nested
    expect(lib!.headers.map((h) => h.rel).sort()).toEqual(['MyLib.h', 'util/helper.h']);
    expect(lib!.sources).toHaveLength(1);
    expect(lib!.sources[0]).toMatchObject({ rel: 'MyLib.cpp', language: 'c++' });
  });

  it('parses the legacy flat format (headers/sources at the library root)', () => {
    const lib = parseArduinoLibrary([
      entry('FlatLib/FlatLib.h', 'void f();\n'),
      entry('FlatLib/FlatLib.cpp', 'void f(){}\n'),
      entry('FlatLib/extra.c', 'int g(){return 1;}\n'),
    ]);
    expect(lib!.name).toBe('FlatLib'); // from the folder name (no library.properties)
    expect(lib!.provides).toEqual(['FlatLib.h']);
    expect(lib!.sources.map((s) => `${s.rel}:${s.language}`).sort()).toEqual([
      'FlatLib.cpp:c++',
      'extra.c:c',
    ]);
  });

  it('returns null for a zip with no compilable code (not a library)', () => {
    expect(parseArduinoLibrary([entry('docs/readme.txt', 'hi'), entry('img/logo.png')])).toBeNull();
  });

  it('parses architectures + depends metadata, stripping version constraints (AUD-018)', () => {
    const lib = parseArduinoLibrary([
      entry(
        'Dht/library.properties',
        'name=DHT sensor library\nversion=1.4.6\narchitectures=avr, esp32 , ESP8266\ndepends=Adafruit Unified Sensor (>=1.1.4), Adafruit BusIO\n',
      ),
      entry('Dht/src/DHT.h', '#pragma once\n'),
      entry('Dht/src/DHT.cpp', '// impl\n'),
    ]);
    expect(lib!.architectures).toEqual(['avr', 'esp32', 'esp8266']); // trimmed + lowercased
    expect(lib!.depends).toEqual(['adafruit unified sensor', 'adafruit busio']); // version constraint stripped
  });

  it('defaults architectures to [*] and depends to [] when library.properties omits them (AUD-018)', () => {
    const lib = parseArduinoLibrary([entry('FlatLib/FlatLib.h', 'void f();\n')]);
    expect(lib!.architectures).toEqual(['*']);
    expect(lib!.depends).toEqual([]);
  });
});
