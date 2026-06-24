/**
 * Build index — REFERENCE-SPEC §10. Primary store: SQLite-WASM over OPFS (must run
 * in a Worker that is cross-origin isolated). Fallback: IndexedDB (invariant I9).
 *
 * Tables (content-hash keyed, never mtime — invariant I5):
 *   installed_packs, object_cache, firmware_cache, source_hashes,
 *   capability_history, and a generic project_kv for build_graph /
 *   dependency_graph / last_build / diagnostics payloads.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { OPFS_LAYOUT } from './layout.js';

// Local typing for the oo1 API subset we use — keeps our usage strict-typed
// regardless of the published package's looser declarations.
interface Oo1Db {
  exec(sql: string): void;
  exec(opts: { sql: string; bind?: unknown[] | Record<string, unknown> }): unknown;
  selectObjects(
    sql: string,
    bind?: unknown[] | Record<string, unknown>,
  ): Array<Record<string, unknown>>;
  selectObject(
    sql: string,
    bind?: unknown[] | Record<string, unknown>,
  ): Record<string, unknown> | undefined;
  close(): void;
}
interface Sqlite3Like {
  oo1: { OpfsDb: new (filename: string, flags?: string) => Oo1Db };
}

export interface InstalledPackRecord {
  name: string;
  version: string;
  packType: string;
  manifestHash: string;
  sizeBytes: number;
  installedAt: number;
}

export interface ObjectCacheRecord {
  path: string;
  sizeBytes: number;
  /** Wall-clock of the last store/hit — drives LRU eviction (not part of any build hash). */
  lastUsedAt: number;
}

/** Object-cache listing row used by LRU eviction. */
export interface ObjectCacheEntry {
  objectKey: string;
  sizeBytes: number;
  lastUsedAt: number;
}

export interface FirmwareCacheRecord {
  boardId: string;
  path: string;
}

export interface CapabilitySnapshot {
  json: string;
  createdAt: number;
}

export interface BuildIndex {
  readonly backend: 'sqlite' | 'indexeddb';
  init(): Promise<void>;

  recordInstalledPack(rec: InstalledPackRecord): Promise<void>;
  listInstalledPacks(): Promise<InstalledPackRecord[]>;
  getInstalledPack(name: string, version?: string): Promise<InstalledPackRecord | null>;
  removeInstalledPack(name: string, version: string): Promise<void>;

  putObject(objectKey: string, rec: ObjectCacheRecord): Promise<void>;
  getObject(objectKey: string): Promise<ObjectCacheRecord | null>;
  /** Bump an object's last-used time (LRU). */
  touchObject(objectKey: string, lastUsedAt: number): Promise<void>;
  /** All cached objects with size + last-used (for LRU eviction). */
  listObjects(): Promise<ObjectCacheEntry[]>;
  /** Drop one object-cache entry (the caller deletes the file). */
  deleteObject(objectKey: string): Promise<void>;

  putFirmware(firmwareKey: string, rec: FirmwareCacheRecord): Promise<void>;
  getFirmware(firmwareKey: string): Promise<FirmwareCacheRecord | null>;

  setSourceHash(path: string, hash: string): Promise<void>;
  getSourceHash(path: string): Promise<string | null>;

  recordCapability(json: string): Promise<void>;
  latestCapability(): Promise<CapabilitySnapshot | null>;

  /** Generic project-scoped JSON (build_graph, dependency_graph, last_build, diagnostics). */
  putProjectJson(table: string, projectId: string, json: string): Promise<void>;
  getProjectJson(table: string, projectId: string): Promise<string | null>;

  close(): Promise<void>;
}

const DDL = `
CREATE TABLE IF NOT EXISTS installed_packs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, packType TEXT NOT NULL,
  manifestHash TEXT NOT NULL, sizeBytes INTEGER NOT NULL, installedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS object_cache (
  objectKey TEXT PRIMARY KEY, path TEXT NOT NULL, sizeBytes INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS firmware_cache (
  firmwareKey TEXT PRIMARY KEY, boardId TEXT NOT NULL, path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_hashes (
  path TEXT PRIMARY KEY, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capability_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_kv (
  tbl TEXT NOT NULL, projectId TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (tbl, projectId)
);
`;

function packId(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Numeric dotted-version compare (semver-ish): orders by each dotted segment
 * numerically so 1.2.10 > 1.2.9 (lexicographic/localeCompare gets this wrong).
 * Non-numeric segments fall back to string compare; missing segments count as 0.
 * Returns <0 if a<b, 0 if equal, >0 if a>b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isInteger(na) && Number.isInteger(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** Pick the record with the semantically-latest version, or null if none. */
function pickLatest(rows: InstalledPackRecord[]): InstalledPackRecord | null {
  let latest: InstalledPackRecord | null = null;
  for (const r of rows) {
    if (!latest || compareSemver(r.version, latest.version) > 0) latest = r;
  }
  return latest;
}

// ───────────────────────────── SQLite backend ─────────────────────────────

class SqliteBuildIndex implements BuildIndex {
  readonly backend = 'sqlite' as const;
  private db: Oo1Db | null = null;

  async init(): Promise<void> {
    const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3Like;
    // OpfsDb throws if the OPFS sync-access VFS is unavailable (non-worker / no COI).
    this.db = new sqlite3.oo1.OpfsDb(`/${OPFS_LAYOUT.db.buildIndex}`, 'c');
    this.db.exec(DDL);
    // migrate DBs created before the LRU column existed (no-op if already present)
    try {
      this.db.exec(`ALTER TABLE object_cache ADD COLUMN lastUsedAt INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
  }

  private get d(): Oo1Db {
    if (!this.db) throw new Error('BuildIndex not initialized');
    return this.db;
  }

  async recordInstalledPack(r: InstalledPackRecord): Promise<void> {
    this.d.exec({
      sql: `INSERT OR REPLACE INTO installed_packs
            (id,name,version,packType,manifestHash,sizeBytes,installedAt)
            VALUES (?,?,?,?,?,?,?)`,
      bind: [
        packId(r.name, r.version),
        r.name,
        r.version,
        r.packType,
        r.manifestHash,
        r.sizeBytes,
        r.installedAt,
      ],
    });
  }

  async listInstalledPacks(): Promise<InstalledPackRecord[]> {
    return this.d
      .selectObjects(
        `SELECT name,version,packType,manifestHash,sizeBytes,installedAt
                      FROM installed_packs ORDER BY name,version`,
      )
      .map((row: Record<string, unknown>) => row as unknown as InstalledPackRecord);
  }

  async getInstalledPack(name: string, version?: string): Promise<InstalledPackRecord | null> {
    if (version) {
      const row = this.d.selectObject(
        `SELECT name,version,packType,manifestHash,sizeBytes,installedAt FROM installed_packs WHERE id=?`,
        [packId(name, version)],
      );
      return (row as unknown as InstalledPackRecord) ?? null;
    }
    // SQL ORDER BY version is lexicographic (1.2.10 < 1.2.9); fetch all and pick
    // the semantically-latest in JS.
    const rows = this.d.selectObjects(
      `SELECT name,version,packType,manifestHash,sizeBytes,installedAt FROM installed_packs WHERE name=?`,
      [name],
    ) as unknown as InstalledPackRecord[];
    return pickLatest(rows);
  }

  async removeInstalledPack(name: string, version: string): Promise<void> {
    this.d.exec({ sql: `DELETE FROM installed_packs WHERE id=?`, bind: [packId(name, version)] });
  }

  async putObject(objectKey: string, rec: ObjectCacheRecord): Promise<void> {
    this.d.exec({
      sql: `INSERT OR REPLACE INTO object_cache (objectKey,path,sizeBytes,lastUsedAt) VALUES (?,?,?,?)`,
      bind: [objectKey, rec.path, rec.sizeBytes, rec.lastUsedAt],
    });
  }

  async getObject(objectKey: string): Promise<ObjectCacheRecord | null> {
    const row = this.d.selectObject(
      `SELECT path,sizeBytes,lastUsedAt FROM object_cache WHERE objectKey=?`,
      [objectKey],
    );
    return (row as unknown as ObjectCacheRecord) ?? null;
  }

  async touchObject(objectKey: string, lastUsedAt: number): Promise<void> {
    this.d.exec({
      sql: `UPDATE object_cache SET lastUsedAt=? WHERE objectKey=?`,
      bind: [lastUsedAt, objectKey],
    });
  }

  async listObjects(): Promise<ObjectCacheEntry[]> {
    return this.d
      .selectObjects(`SELECT objectKey,sizeBytes,lastUsedAt FROM object_cache`)
      .map((row: Record<string, unknown>) => row as unknown as ObjectCacheEntry);
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.d.exec({ sql: `DELETE FROM object_cache WHERE objectKey=?`, bind: [objectKey] });
  }

  async putFirmware(firmwareKey: string, rec: FirmwareCacheRecord): Promise<void> {
    this.d.exec({
      sql: `INSERT OR REPLACE INTO firmware_cache (firmwareKey,boardId,path) VALUES (?,?,?)`,
      bind: [firmwareKey, rec.boardId, rec.path],
    });
  }

  async getFirmware(firmwareKey: string): Promise<FirmwareCacheRecord | null> {
    const row = this.d.selectObject(`SELECT boardId,path FROM firmware_cache WHERE firmwareKey=?`, [
      firmwareKey,
    ]);
    return (row as unknown as FirmwareCacheRecord) ?? null;
  }

  async setSourceHash(path: string, hash: string): Promise<void> {
    this.d.exec({
      sql: `INSERT OR REPLACE INTO source_hashes (path,hash) VALUES (?,?)`,
      bind: [path, hash],
    });
  }

  async getSourceHash(path: string): Promise<string | null> {
    const row = this.d.selectObject(`SELECT hash FROM source_hashes WHERE path=?`, [path]);
    return row ? String(row.hash) : null;
  }

  async recordCapability(json: string): Promise<void> {
    this.d.exec({
      sql: `INSERT INTO capability_history (json,createdAt) VALUES (?,?)`,
      bind: [json, isoNow()],
    });
  }

  async latestCapability(): Promise<CapabilitySnapshot | null> {
    const row = this.d.selectObject(
      `SELECT json,createdAt FROM capability_history ORDER BY id DESC LIMIT 1`,
    );
    return (row as unknown as CapabilitySnapshot) ?? null;
  }

  async putProjectJson(table: string, projectId: string, json: string): Promise<void> {
    this.d.exec({
      sql: `INSERT OR REPLACE INTO project_kv (tbl,projectId,json) VALUES (?,?,?)`,
      bind: [table, projectId, json],
    });
  }

  async getProjectJson(table: string, projectId: string): Promise<string | null> {
    const row = this.d.selectObject(`SELECT json FROM project_kv WHERE tbl=? AND projectId=?`, [
      table,
      projectId,
    ]);
    return row ? String(row.json) : null;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

// ────────────────────────── IndexedDB fallback ──────────────────────────

const IDB_NAME = 'sparklab-index';
const STORES = [
  'installed_packs',
  'object_cache',
  'firmware_cache',
  'source_hashes',
  'capability_history',
  'project_kv',
] as const;

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function isoNow(): number {
  return Date.now();
}

class IdbBuildIndex implements BuildIndex {
  readonly backend = 'indexeddb' as const;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) {
            db.createObjectStore(
              s,
              s === 'capability_history' ? { autoIncrement: true } : undefined,
            );
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private store(name: string, mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error('BuildIndex not initialized');
    return this.db.transaction(name, mode).objectStore(name);
  }

  async recordInstalledPack(r: InstalledPackRecord): Promise<void> {
    await idbReq(this.store('installed_packs', 'readwrite').put(r, packId(r.name, r.version)));
  }

  async listInstalledPacks(): Promise<InstalledPackRecord[]> {
    const all = (await idbReq(
      this.store('installed_packs', 'readonly').getAll(),
    )) as InstalledPackRecord[];
    // Order by name, then numeric version (1.2.9 before 1.2.10 — not lexicographic).
    return all.sort((a, b) => a.name.localeCompare(b.name) || compareSemver(a.version, b.version));
  }

  async getInstalledPack(name: string, version?: string): Promise<InstalledPackRecord | null> {
    if (version) {
      const r = (await idbReq(
        this.store('installed_packs', 'readonly').get(packId(name, version)),
      )) as InstalledPackRecord | undefined;
      return r ?? null;
    }
    const matches = (await this.listInstalledPacks()).filter((p) => p.name === name);
    return pickLatest(matches);
  }

  async removeInstalledPack(name: string, version: string): Promise<void> {
    await idbReq(this.store('installed_packs', 'readwrite').delete(packId(name, version)));
  }

  async putObject(objectKey: string, rec: ObjectCacheRecord): Promise<void> {
    await idbReq(this.store('object_cache', 'readwrite').put(rec, objectKey));
  }

  async getObject(objectKey: string): Promise<ObjectCacheRecord | null> {
    return ((await idbReq(this.store('object_cache', 'readonly').get(objectKey))) ??
      null) as ObjectCacheRecord | null;
  }

  async touchObject(objectKey: string, lastUsedAt: number): Promise<void> {
    const rec = (await idbReq(this.store('object_cache', 'readonly').get(objectKey))) as
      | ObjectCacheRecord
      | undefined;
    if (rec)
      await idbReq(this.store('object_cache', 'readwrite').put({ ...rec, lastUsedAt }, objectKey));
  }

  async listObjects(): Promise<ObjectCacheEntry[]> {
    const s = this.store('object_cache', 'readonly');
    const recs = (await idbReq(s.getAll())) as ObjectCacheRecord[];
    const keys = (await idbReq(s.getAllKeys())) as IDBValidKey[];
    return recs.map((r, i) => ({
      objectKey: String(keys[i]),
      sizeBytes: r.sizeBytes,
      lastUsedAt: r.lastUsedAt ?? 0,
    }));
  }

  async deleteObject(objectKey: string): Promise<void> {
    await idbReq(this.store('object_cache', 'readwrite').delete(objectKey));
  }

  async putFirmware(firmwareKey: string, rec: FirmwareCacheRecord): Promise<void> {
    await idbReq(this.store('firmware_cache', 'readwrite').put(rec, firmwareKey));
  }

  async getFirmware(firmwareKey: string): Promise<FirmwareCacheRecord | null> {
    return ((await idbReq(this.store('firmware_cache', 'readonly').get(firmwareKey))) ??
      null) as FirmwareCacheRecord | null;
  }

  async setSourceHash(path: string, hash: string): Promise<void> {
    await idbReq(this.store('source_hashes', 'readwrite').put(hash, path));
  }

  async getSourceHash(path: string): Promise<string | null> {
    return ((await idbReq(this.store('source_hashes', 'readonly').get(path))) ?? null) as
      | string
      | null;
  }

  async recordCapability(json: string): Promise<void> {
    await idbReq(this.store('capability_history', 'readwrite').put({ json, createdAt: isoNow() }));
  }

  async latestCapability(): Promise<CapabilitySnapshot | null> {
    const all = (await idbReq(
      this.store('capability_history', 'readonly').getAll(),
    )) as CapabilitySnapshot[];
    return all.length ? all[all.length - 1]! : null;
  }

  async putProjectJson(table: string, projectId: string, json: string): Promise<void> {
    await idbReq(this.store('project_kv', 'readwrite').put(json, `${table}:${projectId}`));
  }

  async getProjectJson(table: string, projectId: string): Promise<string | null> {
    return ((await idbReq(this.store('project_kv', 'readonly').get(`${table}:${projectId}`))) ??
      null) as string | null;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

/**
 * Open the build index. Prefers SQLite-WASM over OPFS (the spec's store); falls
 * back to IndexedDB when the OPFS sync-access VFS is unavailable (non-worker, no
 * COI, or unsupported browser).
 */
export async function openBuildIndex(): Promise<BuildIndex> {
  try {
    const idx = new SqliteBuildIndex();
    await idx.init();
    return idx;
  } catch {
    const idx = new IdbBuildIndex();
    await idx.init();
    return idx;
  }
}

export { SqliteBuildIndex, IdbBuildIndex, compareSemver, pickLatest };
