/**
 * Resolve the closure of user libraries a sketch needs to compile: the libraries it directly `#include`s,
 * PLUS their transitive `depends` (from each library's library.properties), with cycle detection and a
 * report of unresolved dependencies. Also classifies architecture compatibility so a board/architecture
 * mismatch is reported BEFORE the build, instead of surfacing as a confusing link error (AUD-018).
 *
 * Pure (no I/O, no worker state) so it unit-tests directly. The build worker feeds it the directly-used
 * libraries as roots and the full installed set, and links the returned closure in dependency order.
 */
import type { UserLibrary } from './arduino-library';

export type BoardArchitecture = 'avr' | 'riscv32' | 'xtensa';

/**
 * Arduino `architectures=` tokens each board architecture is compatible with (besides the wildcard `*`).
 * ESP32-C3 (riscv32) and ESP32-classic (xtensa) are both part of the arduino-esp32 core → `esp32`; the
 * classic Xtensa ISA is also shared with esp8266.
 */
const ARCH_TOKENS: Record<BoardArchitecture, string[]> = {
  avr: ['avr'],
  riscv32: ['esp32'],
  xtensa: ['esp32', 'esp8266'],
};

/** Whether a library declares compatibility with the given board architecture (`*` ⇒ any). */
export function architectureMatches(lib: UserLibrary, board: BoardArchitecture): boolean {
  const arch = lib.architectures.length ? lib.architectures : ['*'];
  if (arch.includes('*')) return true;
  const ok = ARCH_TOKENS[board];
  return arch.some((a) => ok.includes(a.toLowerCase()));
}

export interface LibraryClosure {
  /** Libraries to compile + link, dependencies BEFORE dependents (post-order). */
  closure: UserLibrary[];
  /** `depends` names with no matching installed library (the build will likely fail to resolve includes). */
  missing: string[];
  /** Names participating in a dependency cycle — reported (not fatal); each library still appears once. */
  cycles: string[];
  /** Closure members NOT compatible with the board architecture (declared `architectures` excludes it). */
  incompatible: { name: string; architectures: string[] }[];
}

/**
 * Transitive closure of `roots` over `depends`, resolving dependency names against `all` (the installed set)
 * case-insensitively. Detects cycles (a name reached while still on the resolution stack) and missing
 * dependencies. Output is post-order (a dependency precedes its dependent) so the linker sees a leaf before
 * its user. Every library appears at most once even under a cycle, so resolution always terminates.
 */
export function resolveLibraryClosure(
  roots: UserLibrary[],
  all: UserLibrary[],
  board: BoardArchitecture,
): LibraryClosure {
  const byName = new Map(all.map((l) => [l.name.toLowerCase(), l]));
  const closure: UserLibrary[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const missing = new Set<string>();
  const cycles = new Set<string>();

  const visit = (lib: UserLibrary): void => {
    const key = lib.name.toLowerCase();
    if (done.has(key)) return;
    onStack.add(key);
    for (const dep of lib.depends) {
      const depKey = dep.toLowerCase();
      const depLib = byName.get(depKey);
      if (!depLib) {
        missing.add(dep);
        continue;
      }
      if (onStack.has(depKey)) {
        cycles.add(depLib.name); // back edge → cycle; don't recurse (would not terminate)
        continue;
      }
      visit(depLib);
    }
    onStack.delete(key);
    done.add(key);
    closure.push(lib); // post-order: dependencies already pushed
  };

  for (const r of roots) visit(r);

  const incompatible = closure
    .filter((l) => !architectureMatches(l, board))
    .map((l) => ({ name: l.name, architectures: l.architectures }));

  return { closure, missing: [...missing], cycles: [...cycles], incompatible };
}

/** Human-facing (Vietnamese) non-fatal notes for an unusual closure — missing deps, cycles, arch mismatch. */
export function closureNotes(c: LibraryClosure): string[] {
  const notes: string[] = [];
  if (c.missing.length) {
    notes.push(
      `Thư viện phụ thuộc chưa được cài: ${c.missing.join(', ')}. Hãy cài thêm các thư viện này nếu build báo thiếu header.`,
    );
  }
  if (c.cycles.length) {
    notes.push(
      `Phát hiện phụ thuộc vòng giữa các thư viện: ${c.cycles.join(', ')} — vẫn build, mỗi thư viện chỉ biên dịch một lần.`,
    );
  }
  for (const inc of c.incompatible) {
    notes.push(
      `Thư viện "${inc.name}" khai báo chỉ hỗ trợ kiến trúc [${inc.architectures.join(', ')}], có thể không tương thích board hiện tại — vẫn thử build, trình biên dịch sẽ báo nếu không dựng được.`,
    );
  }
  return notes;
}
