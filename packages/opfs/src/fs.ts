/**
 * Virtual filesystem layer (Stage 0). Primary backend = OPFS; fallback = IndexedDB
 * for browsers without OPFS (e.g. Firefox) — invariant I9 graceful degradation.
 *
 * Paths are POSIX-like, relative to the OPFS root (the virtual disk). Directory
 * segments map to nested FileSystemDirectoryHandles.
 */

export type FileData = Uint8Array | ArrayBuffer | string;

export interface VirtualFs {
  readonly backend: 'opfs' | 'indexeddb';
  mkdirp(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, data: FileData): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readFileText(path: string): Promise<string>;
  list(dirPath: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  size(path: string): Promise<number>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toUint8(data: FileData): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/**
 * Reject paths that could traverse outside the virtual disk or carry control characters (AUD-012).
 * Applied identically by BOTH backends so OPFS (segment handles) and IndexedDB (string keys) agree on
 * what a legal path is — previously `..`/`.` were thrown by OPFS but stored verbatim as an IDB key, so
 * the two backends disagreed. Empty segments (from `//` or a trailing `/`) are allowed; `''` is the root.
 */
/** True if `s` contains any ASCII control character (code < 0x20) — checked without a control-char regex. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

export function assertSafePath(path: string): void {
  if (path.includes(String.fromCharCode(92)) || hasControlChar(path)) {
    throw new Error(`unsafe path rejected (control char or backslash): ${JSON.stringify(path)}`);
  }
  for (const seg of path.split('/')) {
    if (seg === '..' || seg === '.') {
      throw new Error(`unsafe path segment rejected (traversal): ${JSON.stringify(path)}`);
    }
  }
}

function splitPath(path: string): string[] {
  assertSafePath(path);
  return path.split('/').filter((s) => s.length > 0);
}

// ───────────────────────────── OPFS backend ─────────────────────────────

class OpfsFs implements VirtualFs {
  readonly backend = 'opfs' as const;

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async dirHandle(
    segments: string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    let dir = this.root;
    for (const seg of segments) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch {
        if (!create) return null;
        throw new Error(`failed to create directory segment: ${seg}`);
      }
    }
    return dir;
  }

  async mkdirp(path: string): Promise<void> {
    await this.dirHandle(splitPath(path), true);
  }

  private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const segs = splitPath(path);
    const fileName = segs.pop();
    if (!fileName) throw new Error(`invalid file path: ${path}`);
    const dir = await this.dirHandle(segs, create);
    if (!dir) return null;
    try {
      return await dir.getFileHandle(fileName, { create });
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    const segs = splitPath(path);
    if (segs.length === 0) return true;
    const name = segs[segs.length - 1]!;
    const parent = await this.dirHandle(segs.slice(0, -1), false);
    if (!parent) return false;
    try {
      await parent.getFileHandle(name);
      return true;
    } catch {
      try {
        await parent.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    }
  }

  async writeFile(path: string, data: FileData): Promise<void> {
    const handle = await this.fileHandle(path, true);
    if (!handle) throw new Error(`cannot open for write: ${path}`);
    const writable = await handle.createWritable();
    try {
      const bytes = toUint8(data);
      await writable.write(bytes as BufferSource);
    } finally {
      await writable.close();
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const handle = await this.fileHandle(path, false);
    if (!handle) throw new Error(`file not found: ${path}`);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readFileText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  async list(dirPath: string): Promise<string[]> {
    const dir = await this.dirHandle(splitPath(dirPath), false);
    if (!dir) return [];
    const names: string[] = [];
    // FileSystemDirectoryHandle is async-iterable over [name, handle].
    for await (const [name] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      names.push(name);
    }
    return names.sort();
  }

  async remove(path: string): Promise<void> {
    const segs = splitPath(path);
    const name = segs.pop();
    if (!name) throw new Error(`cannot remove root`);
    const parent = await this.dirHandle(segs, false);
    if (!parent) return;
    await parent.removeEntry(name, { recursive: true }).catch(() => undefined);
  }

  async size(path: string): Promise<number> {
    const handle = await this.fileHandle(path, false);
    if (!handle) throw new Error(`file not found: ${path}`);
    return (await handle.getFile()).size;
  }
}

// ────────────────────────── IndexedDB fallback ──────────────────────────

const IDB_DB = 'sparklab-fs';
const IDB_STORE = 'files';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IdbFs implements VirtualFs {
  readonly backend = 'indexeddb' as const;

  constructor(private readonly db: IDBDatabase) {}

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
  }

  async mkdirp(): Promise<void> {
    // No directory concept needed: keys carry the full path.
  }

  async exists(path: string): Promise<boolean> {
    assertSafePath(path); // same path rules as the OPFS backend (AUD-012)
    const key = await idbReq(this.tx('readonly').getKey(path));
    if (key !== undefined) return true;
    // directory existence: any key under prefix
    const names = await this.list(path);
    return names.length > 0;
  }

  async writeFile(path: string, data: FileData): Promise<void> {
    assertSafePath(path);
    await idbReq(this.tx('readwrite').put(toUint8(data), path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    assertSafePath(path);
    const v = await idbReq<unknown>(this.tx('readonly').get(path));
    if (!v) throw new Error(`file not found: ${path}`);
    return v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
  }

  async readFileText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  async list(dirPath: string): Promise<string[]> {
    assertSafePath(dirPath);
    const prefix = dirPath.endsWith('/') || dirPath === '' ? dirPath : `${dirPath}/`;
    const keys = (await idbReq(this.tx('readonly').getAllKeys())) as string[];
    const children = new Set<string>();
    for (const k of keys) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (seg) children.add(seg);
      }
    }
    return [...children].sort();
  }

  async remove(path: string): Promise<void> {
    assertSafePath(path);
    const store = this.tx('readwrite');
    await idbReq(store.delete(path));
    const prefix = `${path}/`;
    const keys = (await idbReq(this.tx('readonly').getAllKeys())) as string[];
    for (const k of keys) {
      if (k.startsWith(prefix)) await idbReq(this.tx('readwrite').delete(k));
    }
  }

  async size(path: string): Promise<number> {
    return (await this.readFile(path)).byteLength;
  }
}

/**
 * Open the best available virtual filesystem for this environment. OPFS is preferred; IndexedDB is the
 * fallback. Crucially, the OPFS branch is tried inside a try/catch (AUD-012): a browser can EXPOSE
 * `navigator.storage.getDirectory` yet have the call fail (permission denied, sandboxed iframe, transient
 * error) — previously that rejected with no fallback. Now such a failure degrades to IndexedDB when it is
 * available, and only throws when neither backend can be opened (with both reasons surfaced).
 */
export async function openFs(): Promise<VirtualFs> {
  let opfsError: unknown = null;
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory();
      return new OpfsFs(root);
    } catch (e) {
      opfsError = e; // API present but unusable here → try IndexedDB rather than failing outright
    }
  }
  if (typeof indexedDB !== 'undefined') {
    return new IdbFs(await openIdb());
  }
  const why = opfsError
    ? `OPFS failed (${opfsError instanceof Error ? opfsError.message : String(opfsError)}) and `
    : '';
  throw new Error(`no persistent storage backend available: ${why}no IndexedDB`);
}
