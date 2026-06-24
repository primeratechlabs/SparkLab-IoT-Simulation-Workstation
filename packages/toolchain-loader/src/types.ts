/**
 * Toolchain abstraction shared by the stub (Stage 1) and the real WASM toolchains
 * (Stage 2 avr-gcc, Stage 4 riscv clang, …). The BuildDaemon depends only on this
 * interface, so swapping in a real toolchain requires no orchestrator changes.
 */

import type { Sha256, Diagnostic } from '@sparklab/shared';

export interface CompileInput {
  sourceKey: Sha256;
  sourceBytes: Uint8Array;
  target: string; // target triple, e.g. "avr-atmega328p"
  flags: string[]; // includes reproducible-build flags
  includedHeaderHashes: Sha256[];
  /** Source language — picks cc1 (C) vs cc1plus (C++). Defaults to "c++" (Arduino). */
  language?: 'c' | 'c++';
  /** Extra header files mounted into the compile FS (user-uploaded library headers). Their bytes are
   *  already reflected in `includedHeaderHashes`, so the object cache invalidates when they change. */
  extraHeaders?: { path: string; bytes: Uint8Array }[];
}

export interface CompileOutput {
  object: Uint8Array;
  dep: string; // make-style .d dependency text
  diagnostics: Diagnostic[];
}

export interface LinkInput {
  objects: Uint8Array[]; // stable order (link order matters — invariant I4)
  target: string;
  flags: string[];
}

export interface LinkOutput {
  elf: Uint8Array;
  map: string;
  diagnostics: Diagnostic[];
}

export interface Toolchain {
  /** Stable compiler identity used in cache keys (e.g. "stub-cc@1"). */
  readonly id: string;
  readonly variant: 'threaded' | 'singlethread';
  // Async: the real toolchain runs WASM tools (cc1/as/ld) which are async; the
  // stub resolves immediately. Callers must await.
  compile(input: CompileInput): Promise<CompileOutput>;
  link(input: LinkInput): Promise<LinkOutput>;
}
