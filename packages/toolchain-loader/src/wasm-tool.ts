/**
 * WasmTool — drives an Emscripten-compiled CLI tool (avr-as / avr-ld / avr-objcopy
 * / cc1 …) from JS. Because the browser has no fork/exec, the toolchain-loader acts
 * as the gcc DRIVER: it loads each tool as an Emscripten ES-module factory, writes
 * inputs into the in-memory FS, calls main with argv, and reads outputs back out.
 *
 * The tools are built MODULARIZE + EXPORT_ES6 + INVOKE_RUN=0 + EXIT_RUNTIME=0 +
 * callMain/FS exported, so a fresh module instance can be invoked per call and its
 * MEMFS stays readable after the tool exits.
 */

export interface EmscriptenFS {
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readFile(path: string, opts: { encoding: 'utf8' }): string;
  unlink(path: string): void;
  analyzePath(path: string): { exists: boolean };
  mkdirTree?(path: string): void;
}

export interface EmscriptenModule {
  callMain(args: string[]): number | undefined;
  FS: EmscriptenFS;
}

export interface EmscriptenModuleOpts {
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  noInitialRun?: boolean;
}

export type EmscriptenModuleFactory = (opts?: EmscriptenModuleOpts) => Promise<EmscriptenModule>;

export interface ToolInput {
  path: string;
  bytes: Uint8Array | string;
}

export interface ToolRunOptions {
  args: string[];
  inputs?: ToolInput[];
  /** Paths to read back out of the tool's FS after it runs. */
  outputs?: string[];
}

export interface ToolRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Map<string, Uint8Array>;
}

function exitStatus(e: unknown): number | null {
  if (e && typeof e === 'object' && 'status' in e) return Number((e as { status: unknown }).status);
  return null;
}

export class WasmTool {
  constructor(
    private readonly factory: EmscriptenModuleFactory,
    readonly id: string,
  ) {}

  /** Run the tool once in a fresh module instance. */
  async run(opts: ToolRunOptions): Promise<ToolRunResult> {
    let stdout = '';
    let stderr = '';
    const mod = await this.factory({
      noInitialRun: true,
      print: (s) => (stdout += s + '\n'),
      printErr: (s) => (stderr += s + '\n'),
    });

    for (const input of opts.inputs ?? []) {
      const slash = input.path.lastIndexOf('/');
      const dir = slash > 0 ? input.path.slice(0, slash) : '';
      if (dir && mod.FS.mkdirTree) mod.FS.mkdirTree(dir);
      mod.FS.writeFile(input.path, input.bytes);
    }

    let exitCode = 0;
    try {
      exitCode = mod.callMain(opts.args) ?? 0;
    } catch (e) {
      const status = exitStatus(e);
      if (status === null) throw e; // genuine runtime error, not a clean exit()
      exitCode = status;
    }

    const outputs = new Map<string, Uint8Array>();
    for (const path of opts.outputs ?? []) {
      try {
        if (mod.FS.analyzePath(path).exists) outputs.set(path, mod.FS.readFile(path));
      } catch {
        /* output not produced */
      }
    }

    return { exitCode, stdout, stderr, outputs };
  }
}
