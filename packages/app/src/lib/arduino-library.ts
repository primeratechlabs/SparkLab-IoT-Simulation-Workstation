/**
 * Parse an extracted Arduino library .zip into the shape the build needs. Supports both layouts arduino
 * libraries ship in: the 1.5 "recursive" format (LibName/library.properties + LibName/src/**) and the
 * legacy 1.0 "flat" format (LibName/*.h, *.cpp). Only the include dir matters for compilation; examples/
 * extras/docs are ignored. Pure (no I/O) so it unit-tests on plain entries.
 */
import type { ZipEntry } from './unzip';

export interface UserLibFile {
  /** Path RELATIVE to the library's include dir (so nested #include "sub/x.h" resolves). */
  rel: string;
  content: string;
}
export interface UserLibrary {
  name: string;
  version: string;
  /** Header basenames a sketch can `#include <X.h>` (top-level headers in the include dir). */
  provides: string[];
  /** Every header (relative to the include dir) — mounted so the compiler resolves includes. */
  headers: UserLibFile[];
  /** Source units to compile + link. */
  sources: { rel: string; content: string; language: 'c' | 'c++' }[];
  /**
   * Arduino `architectures=` tokens (lowercased, e.g. `avr`, `esp32`, `*`). `['*']` when the library
   * declares none — Arduino treats a missing field as "any architecture" (AUD-018). Used to report a
   * board/architecture mismatch BEFORE the build (a confusing link error otherwise).
   */
  architectures: string[];
  /**
   * Other library NAMES this one depends on, from `depends=` — version constraints (`Lib (>=1.0)`) are
   * stripped to the bare name. The build resolves this transitively so a dependency-of-a-dependency is
   * compiled even when the sketch only `#include`s the top library (AUD-018).
   */
  depends: string[];
}

/**
 * Headers the simulator already provides (its HTTP-based Blynk + WiFi shims). A user-uploaded or
 * registry library that ships one of these is REDUNDANT and CONFLICTS (e.g. the real Blynk library
 * defines `Blynk`, duplicating the simulator's) — it's skipped at build time + blocked in the manager,
 * and the sketch's `#include <BlynkSimpleWifi.h>` resolves to the simulator's compatible shim instead.
 */
export const BUILT_IN_HEADERS = new Set([
  'blynk.h',
  'blynksimplewifi.h',
  'blynksimpleesp32.h',
  'blynksimpleesp32_ssl.h',
  'blynksimpleesp8266.h',
  'sparkblynk.h',
  'sparknet.h',
  'wifi.h',
]);
/** Registry library names that are built-in (the manager blocks installing them). */
export const BUILT_IN_LIB_NAMES = new Set(['blynk']);

/** Whether a library (by its provided headers) duplicates a built-in shim → skip it. */
export function isBuiltInLibrary(provides: string[]): boolean {
  return provides.some((h) => BUILT_IN_HEADERS.has(h.toLowerCase()));
}

const td = new TextDecoder();
const isHeader = (p: string): boolean => /\.(h|hpp|hh|inc)$/i.test(p);
const isCpp = (p: string): boolean => /\.(cpp|cc|cxx)$/i.test(p);
const isC = (p: string): boolean => /\.c$/i.test(p);

/** The single top-level folder shared by all entries (e.g. "MyLib"), or '' if the zip is flat. */
function commonRoot(entries: ZipEntry[]): string {
  const firsts = new Set(entries.map((e) => e.name.split('/')[0]));
  if (firsts.size === 1) {
    const only = [...firsts][0]!;
    // Only treat it as a root folder if every entry actually nests under it (has a slash).
    if (entries.every((e) => e.name.startsWith(`${only}/`))) return only;
  }
  return '';
}

interface LibProps {
  name?: string;
  version?: string;
  architectures?: string[];
  depends?: string[];
}

/** Split an Arduino comma-list field (`avr, esp32`) into trimmed, non-empty, lowercased tokens. */
const splitList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** `depends=Foo (>=1.0.0), Bar` → bare names `['foo', 'bar']` (version constraints stripped). */
const splitDepends = (v: string): string[] =>
  v
    .split(',')
    .map((s) =>
      s
        .replace(/\(.*?\)/g, '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

function parseProps(content: string): LibProps {
  const out: LibProps = {};
  for (const line of content.split('\n')) {
    const m = /^(name|version|architectures|depends)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!; // both groups are guaranteed present on a successful match
    const val = m[2]!;
    if (key === 'name' || key === 'version') out[key] = val;
    else if (key === 'architectures') out.architectures = splitList(val);
    else if (key === 'depends') out.depends = splitDepends(val);
  }
  return out;
}

/**
 * Build a UserLibrary from the archive entries, or null if it carries no compilable C/C++ (not a code
 * library). `name`/`version` come from library.properties when present, else the folder name.
 */
export function parseArduinoLibrary(entries: ZipEntry[]): UserLibrary | null {
  const root = commonRoot(entries);
  const prefix = root ? `${root}/` : '';
  const rel = (name: string): string => name.slice(prefix.length);

  // 1.5 recursive format iff there are code files under <root>/src/.
  const hasSrc = entries.some(
    (e) => rel(e.name).startsWith('src/') && (isHeader(e.name) || isCpp(e.name) || isC(e.name)),
  );
  const incPrefix = hasSrc ? 'src/' : '';

  const props = entries.find((e) => rel(e.name) === 'library.properties');
  const meta = props ? parseProps(td.decode(props.bytes)) : {};

  const headers: UserLibFile[] = [];
  const sources: UserLibrary['sources'] = [];
  const provides: string[] = [];

  for (const e of entries) {
    const r = rel(e.name);
    if (!r.startsWith(incPrefix)) continue; // outside the include dir (examples/, extras/, …)
    const inner = r.slice(incPrefix.length); // path relative to the include dir
    if (!inner || inner.includes('..')) continue;
    if (isHeader(e.name)) {
      headers.push({ rel: inner, content: td.decode(e.bytes) });
      if (!inner.includes('/')) provides.push(inner); // a top-level header → directly includable
    } else if (isCpp(e.name)) {
      sources.push({ rel: inner, content: td.decode(e.bytes), language: 'c++' });
    } else if (isC(e.name)) {
      sources.push({ rel: inner, content: td.decode(e.bytes), language: 'c' });
    }
  }

  if (!headers.length && !sources.length) return null; // not a code library
  const name =
    (meta.name && meta.name.trim()) || root || provides[0]?.replace(/\.\w+$/, '') || 'library';
  return {
    name,
    version: meta.version?.trim() || '0.0.0',
    provides,
    headers,
    sources,
    architectures: meta.architectures?.length ? meta.architectures : ['*'],
    depends: meta.depends ?? [],
  };
}
