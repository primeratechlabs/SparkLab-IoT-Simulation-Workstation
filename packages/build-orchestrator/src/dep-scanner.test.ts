import { describe, it, expect } from 'vitest';
import { SdkMount } from '@sparklab/toolchain-loader';
import { sha256, type ResolvedLibrary } from '@sparklab/shared';
import {
  scanIncludeDirectives,
  buildDependencyGraph,
  updateDependencyGraph,
  LibraryIndex,
  type SourceUnit,
} from './dep-scanner.js';

const enc = new TextEncoder();

function lib(name: string): ResolvedLibrary {
  return {
    name,
    version: '1.0.0',
    srcDir: `/lib/${name}`,
    headers: [`${name}.h`],
    depends: [],
    architectures: ['avr'],
    source: 'prebuilt-pack',
  };
}

async function unit(id: string, src: string): Promise<SourceUnit> {
  const bytes = enc.encode(src);
  return { id, sourceKey: await sha256(bytes), sourceBytes: bytes };
}

function makeMount(): { mount: SdkMount; libraryIndex: LibraryIndex } {
  const mount = new SdkMount();
  mount.registerHeader('/sdk/core', 'Arduino.h', enc.encode('// arduino core\n'));
  mount.addIncludePath('/lib/Servo', 'Servo');
  mount.registerHeader('/lib/Servo', 'Servo.h', enc.encode('#include "Arduino.h"\n// servo\n'));
  const libraryIndex = new LibraryIndex();
  libraryIndex.add(lib('Servo'), ['Servo.h']);
  return { mount, libraryIndex };
}

describe('dep-scanner', () => {
  it('parses #include directives (both forms)', () => {
    const d = scanIncludeDirectives('#include <Arduino.h>\n#include "Servo.h"\nint x;');
    expect(d.map((x) => x.name)).toEqual(['Arduino.h', 'Servo.h']);
    expect(d[0]!.system).toBe(true);
    expect(d[1]!.system).toBe(false);
  });

  it('ignores #include inside comments and strings (bug regression)', () => {
    const d = scanIncludeDirectives(
      `#include <Real.h>
// #include <LineCommentGhost.h>
/* #include <BlockGhost.h> */
const char* s = "#include <StringGhost.h>";`,
    );
    expect(d.map((x) => x.name)).toEqual(['Real.h']);
  });

  it('resolves transitive headers and pulls the right library', async () => {
    const { mount, libraryIndex } = makeMount();
    const u = await unit('main', '#include <Servo.h>\nvoid loop(){}');
    const res = await buildDependencyGraph({ units: [u], mount, libraryIndex });
    expect(res.units[0]!.libraries).toContain('Servo');
    // transitive: Servo.h includes Arduino.h
    expect(res.units[0]!.includes).toEqual(['/lib/Servo/Servo.h', '/sdk/core/Arduino.h']);
    expect(res.libraries.map((l) => l.name)).toEqual(['Servo']);
  });

  it('header tree hash changes when a header changes', async () => {
    const { mount, libraryIndex } = makeMount();
    const u = await unit('main', '#include <Servo.h>\n');
    const a = await buildDependencyGraph({ units: [u], mount, libraryIndex });
    mount.registerHeader('/sdk/core', 'Arduino.h', enc.encode('// arduino core EDITED\n'));
    const b = await buildDependencyGraph({ units: [u], mount, libraryIndex });
    expect(a.units[0]!.headerTreeHash).not.toBe(b.units[0]!.headerTreeHash);
  });

  it('incremental: only changed units rescanned; new #include pulls lib (gate 4)', async () => {
    const { mount, libraryIndex } = makeMount();
    const u1 = await unit('a', 'void a(){}');
    const u2 = await unit('b', 'void b(){}');
    const first = await buildDependencyGraph({ units: [u1, u2], mount, libraryIndex });
    expect(first.libraries).toHaveLength(0);

    // Edit unit a to include Servo (sourceKey changes); b unchanged.
    const u1b = await unit('a', '#include <Servo.h>\nvoid a(){}');
    const { result, rescannedUnitIds } = await updateDependencyGraph(first, {
      units: [u1b, u2],
      mount,
      libraryIndex,
    });
    expect(rescannedUnitIds).toEqual(['a']);
    expect(result.libraries.map((l) => l.name)).toEqual(['Servo']);
  });
});
