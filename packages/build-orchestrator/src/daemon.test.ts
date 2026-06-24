import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFs, MemoryBuildIndex } from '@sparklab/opfs';
import { resetToolchains } from '@sparklab/toolchain-loader';
import { BuildDaemonImpl, type SdkConfig } from './daemon.js';

const enc = new TextEncoder();

const SDK: SdkConfig = {
  target: 'avr-atmega328p',
  sdkPackHash: 'sha256:sdk',
  libraryPackHash: 'sha256:libpack',
  boardId: 'uno',
  frameworkVersion: 'arduino-avr@1.8.6',
  toolchainPackHash: 'sha256:tc',
};

function makeDaemon() {
  const fs = new MemoryFs();
  const index = new MemoryBuildIndex();
  const daemon = new BuildDaemonImpl(fs, index);
  daemon.configureSdk(
    SDK,
    [{ includePath: '/sdk/core', name: 'Arduino.h', bytes: enc.encode('// core\n') }],
    [
      {
        name: 'Servo',
        version: '1.2.0',
        includePath: '/lib/Servo',
        providesHeaders: ['Servo.h'],
        architectures: ['avr'],
      },
    ],
  );
  // Register the Servo header so transitive resolution works.
  daemon.configureSdk(
    SDK,
    [
      { includePath: '/sdk/core', name: 'Arduino.h', bytes: enc.encode('// core\n') },
      { includePath: '/lib/Servo', name: 'Servo.h', bytes: enc.encode('// servo\n') },
    ],
    [
      {
        name: 'Servo',
        version: '1.2.0',
        includePath: '/lib/Servo',
        providesHeaders: ['Servo.h'],
        architectures: ['avr'],
      },
    ],
  );
  return { fs, index, daemon };
}

describe('BuildDaemonImpl (Stage 1 pipeline)', () => {
  beforeEach(() => resetToolchains());

  it('builds, links a valid ELF, and stores firmware', async () => {
    const { daemon } = makeDaemon();
    daemon.setProject([
      { id: 'main.cpp', bytes: enc.encode('void setup(){}\nvoid loop(){}') },
      { id: 'util.cpp', bytes: enc.encode('int helper(){return 1;}') },
    ]);
    const out = await daemon.build();
    expect(out.elfValid).toBe(true);
    expect(out.firmwareKey).toMatch(/^sha256:/);
    expect(out.compiledUnitIds.sort()).toEqual(['main.cpp', 'util.cpp']);
    expect(out.reusedUnitIds).toHaveLength(0);
    expect(out.toolchainInstantiations).toBe(1);
  });

  it('rebuild with no changes reuses all objects; toolchain stays warm', async () => {
    const { daemon } = makeDaemon();
    daemon.setProject([
      { id: 'main.cpp', bytes: enc.encode('void loop(){}') },
      { id: 'util.cpp', bytes: enc.encode('int h(){return 1;}') },
    ]);
    await daemon.build();
    const out2 = await daemon.build();
    expect(out2.compiledUnitIds).toHaveLength(0);
    expect(out2.reusedUnitIds.sort()).toEqual(['main.cpp', 'util.cpp']);
    expect(out2.toolchainInstantiations).toBe(1);
  });

  it('changing one source recompiles only that unit (gate 2)', async () => {
    const { daemon } = makeDaemon();
    daemon.setProject([
      { id: 'main.cpp', bytes: enc.encode('void loop(){}') },
      { id: 'util.cpp', bytes: enc.encode('int h(){return 1;}') },
    ]);
    await daemon.build();
    daemon.upsertSource({ id: 'main.cpp', bytes: enc.encode('void loop(){ /* edited */ }') });
    const out = await daemon.build();
    expect(out.compiledUnitIds).toEqual(['main.cpp']);
    expect(out.reusedUnitIds).toEqual(['util.cpp']);
  });

  it('is reproducible across independent daemons (gate 3)', async () => {
    const a = makeDaemon();
    const b = makeDaemon();
    const sources = [
      { id: 'main.cpp', bytes: enc.encode('void loop(){}') },
      { id: 'util.cpp', bytes: enc.encode('int h(){return 1;}') },
    ];
    a.daemon.setProject(sources.map((s) => ({ ...s })));
    b.daemon.setProject(sources.map((s) => ({ ...s })));
    const oa = await a.daemon.build();
    const ob = await b.daemon.build();
    expect(oa.objectKeys).toEqual(ob.objectKeys);
    expect(oa.firmwareKey).toBe(ob.firmwareKey);
    // Stored ELF bytes are byte-identical.
    const elfA = await a.fs.readFile(oa.elfPath!);
    const elfB = await b.fs.readFile(ob.elfPath!);
    expect(Array.from(elfA)).toEqual(Array.from(elfB));
  });

  it('pulls a library when a new #include is added (gate 4)', async () => {
    const { daemon } = makeDaemon();
    daemon.setProject([{ id: 'main.cpp', bytes: enc.encode('#include <Servo.h>\nvoid loop(){}') }]);
    const graph = await daemon.scanDependencies();
    expect(graph.libraries.map((l) => l.name)).toContain('Servo');
  });

  it('surfaces compile errors and produces no firmware', async () => {
    const { daemon } = makeDaemon();
    daemon.setProject([{ id: 'bad.cpp', bytes: enc.encode('#error nope\nvoid loop(){}') }]);
    const out = await daemon.build();
    expect(out.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(out.firmwareKey).toBeNull();
  });
});
