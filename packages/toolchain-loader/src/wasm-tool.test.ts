import { describe, it, expect } from 'vitest';
import { WasmTool, type EmscriptenModule, type EmscriptenModuleFactory } from './wasm-tool.js';

const enc = new TextEncoder();

/** A fake Emscripten module: in-memory FS + a callMain that mimics objcopy-ish I/O. */
function makeFactory(
  behavior: (args: string[], fs: Map<string, Uint8Array>, out: (s: string) => void) => number,
  mkdirCalls?: string[],
): EmscriptenModuleFactory {
  return async (opts) => {
    const files = new Map<string, Uint8Array>();
    const mod: EmscriptenModule = {
      FS: {
        writeFile: (p, d) => files.set(p, typeof d === 'string' ? enc.encode(d) : d),
        readFile: ((p: string) => {
          const v = files.get(p);
          if (!v) throw new Error('ENOENT');
          return v;
        }) as EmscriptenModule['FS']['readFile'],
        unlink: (p) => void files.delete(p),
        analyzePath: (p) => ({ exists: files.has(p) }),
        mkdirTree: (p) => void mkdirCalls?.push(p),
      },
      callMain: (args) => behavior(args, files, (s) => opts?.print?.(s)),
    };
    return mod;
  };
}

describe('WasmTool', () => {
  it('writes inputs, runs, and reads outputs', async () => {
    // Behavior: copy input file (args[0]) to output (args[1]).
    const tool = new WasmTool(
      makeFactory((args, fs) => {
        fs.set(args[1]!, fs.get(args[0]!)!);
        return 0;
      }),
      'fake-objcopy',
    );
    const res = await tool.run({
      args: ['/in.bin', '/out.bin'],
      inputs: [{ path: '/in.bin', bytes: enc.encode('hello') }],
      outputs: ['/out.bin'],
    });
    expect(res.exitCode).toBe(0);
    expect(new TextDecoder().decode(res.outputs.get('/out.bin'))).toBe('hello');
  });

  it('writes a relative input path without mangling the dir (no leading slash)', async () => {
    // Regression: path with no '/' must not call mkdirTree('foo.bi') (slice(0,-1) bug).
    const mkdirCalls: string[] = [];
    const tool = new WasmTool(
      makeFactory((args, fs) => {
        fs.set(args[1]!, fs.get(args[0]!)!);
        return 0;
      }, mkdirCalls),
      'fake-objcopy',
    );
    const res = await tool.run({
      args: ['in.bin', 'out.bin'],
      inputs: [{ path: 'in.bin', bytes: enc.encode('payload') }],
      outputs: ['out.bin'],
    });
    expect(res.exitCode).toBe(0);
    expect(new TextDecoder().decode(res.outputs.get('out.bin'))).toBe('payload');
    // No parent dir exists, so mkdirTree must not be invoked at all.
    expect(mkdirCalls).toEqual([]);
  });

  it('mkdirTrees only the real parent dir for a nested input path', async () => {
    const mkdirCalls: string[] = [];
    const tool = new WasmTool(
      makeFactory(() => 0, mkdirCalls),
      'fake-as',
    );
    await tool.run({
      args: ['noop'],
      inputs: [{ path: '/tmp/build/a.s', bytes: enc.encode('; asm') }],
    });
    expect(mkdirCalls).toEqual(['/tmp/build']);
  });

  it('does not mkdirTree the root for a top-level absolute path', async () => {
    const mkdirCalls: string[] = [];
    const tool = new WasmTool(
      makeFactory(() => 0, mkdirCalls),
      'fake-as',
    );
    await tool.run({
      args: ['noop'],
      inputs: [{ path: '/in.bin', bytes: enc.encode('x') }],
    });
    expect(mkdirCalls).toEqual([]);
  });

  it('returns no output entry when the tool never produces the file', async () => {
    const tool = new WasmTool(
      makeFactory(() => 0), // behavior writes nothing
      'fake-noop',
    );
    const res = await tool.run({
      args: ['/in.bin', '/out.bin'],
      inputs: [{ path: '/in.bin', bytes: enc.encode('hi') }],
      outputs: ['/out.bin'],
    });
    expect(res.exitCode).toBe(0);
    expect(res.outputs.has('/out.bin')).toBe(false);
    expect(res.outputs.size).toBe(0);
  });

  it('captures stdout', async () => {
    const tool = new WasmTool(
      makeFactory((args, _fs, out) => {
        out('GNU ld (fake) 2.43');
        return 0;
      }),
      'fake-ld',
    );
    const res = await tool.run({ args: ['--version'] });
    expect(res.stdout).toContain('GNU ld (fake) 2.43');
  });

  it('treats a thrown ExitStatus as a clean exit code', async () => {
    const tool = new WasmTool(
      makeFactory(() => {
        throw { status: 2, name: 'ExitStatus' };
      }),
      'fake-fail',
    );
    const res = await tool.run({ args: ['bad'] });
    expect(res.exitCode).toBe(2);
  });

  it('rethrows genuine runtime errors', async () => {
    const tool = new WasmTool(
      makeFactory(() => {
        throw new Error('wasm trap: out of bounds');
      }),
      'fake-crash',
    );
    await expect(tool.run({ args: [] })).rejects.toThrow(/out of bounds/);
  });
});
