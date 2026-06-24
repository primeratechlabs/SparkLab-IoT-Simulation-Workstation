/**
 * In-memory implementations of VirtualFs and BuildIndex. Two uses:
 *   1. A volatile fallback for tier C/D environments (no OPFS/IndexedDB) where the
 *      session is preview-only and persistence isn't required (invariant I9).
 *   2. Deterministic test doubles for Node unit tests (no browser storage).
 * Note: these do NOT persist across reloads — callers needing durability use
 * openFs()/openBuildIndex().
 */

import type { FileData, VirtualFs } from './fs.js';
import type {
  BuildIndex,
  InstalledPackRecord,
  ObjectCacheRecord,
  ObjectCacheEntry,
  FirmwareCacheRecord,
  CapabilitySnapshot,
} from './index-db.js';
import { pickLatest } from './index-db.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(d: FileData): Uint8Array {
  if (typeof d === 'string') return encoder.encode(d);
  return d instanceof ArrayBuffer ? new Uint8Array(d) : d;
}

export class MemoryFs implements VirtualFs {
  readonly backend = 'opfs' as const;
  readonly files = new Map<string, Uint8Array>();

  async mkdirp(): Promise<void> {}

  async exists(path: string): Promise<boolean> {
    if (path === '') return true; // root always exists
    if (this.files.has(path)) return true;
    const prefix = `${path}/`;
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  async writeFile(path: string, data: FileData): Promise<void> {
    this.files.set(path, toBytes(data));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const v = this.files.get(path);
    if (!v) throw new Error(`file not found: ${path}`);
    return v;
  }

  async readFileText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  async list(dirPath: string): Promise<string[]> {
    // Root ('') has no separator prefix; top-level keys don't start with '/'.
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) out.add(k.slice(prefix.length).split('/')[0]!);
    }
    return [...out].sort();
  }

  async remove(path: string): Promise<void> {
    for (const k of [...this.files.keys()]) {
      if (k === path || k.startsWith(`${path}/`)) this.files.delete(k);
    }
  }

  async size(path: string): Promise<number> {
    return (await this.readFile(path)).byteLength;
  }
}

export class MemoryBuildIndex implements BuildIndex {
  readonly backend = 'indexeddb' as const;
  private packs = new Map<string, InstalledPackRecord>();
  private objects = new Map<string, ObjectCacheRecord>();
  private firmware = new Map<string, FirmwareCacheRecord>();
  private sources = new Map<string, string>();
  private capability: CapabilitySnapshot[] = [];
  private projectKv = new Map<string, string>();

  async init(): Promise<void> {}

  async recordInstalledPack(r: InstalledPackRecord): Promise<void> {
    this.packs.set(`${r.name}@${r.version}`, r);
  }
  async listInstalledPacks(): Promise<InstalledPackRecord[]> {
    return [...this.packs.values()];
  }
  async getInstalledPack(name: string, version?: string): Promise<InstalledPackRecord | null> {
    if (version) return this.packs.get(`${name}@${version}`) ?? null;
    // Pick the semantically-latest version, matching the SQLite/IDB backends.
    return pickLatest([...this.packs.values()].filter((p) => p.name === name));
  }
  async removeInstalledPack(name: string, version: string): Promise<void> {
    this.packs.delete(`${name}@${version}`);
  }

  async putObject(objectKey: string, rec: ObjectCacheRecord): Promise<void> {
    this.objects.set(objectKey, rec);
  }
  async getObject(objectKey: string): Promise<ObjectCacheRecord | null> {
    return this.objects.get(objectKey) ?? null;
  }
  async touchObject(objectKey: string, lastUsedAt: number): Promise<void> {
    const rec = this.objects.get(objectKey);
    if (rec) this.objects.set(objectKey, { ...rec, lastUsedAt });
  }
  async listObjects(): Promise<ObjectCacheEntry[]> {
    return [...this.objects.entries()].map(([objectKey, r]) => ({
      objectKey,
      sizeBytes: r.sizeBytes,
      lastUsedAt: r.lastUsedAt,
    }));
  }
  async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async putFirmware(firmwareKey: string, rec: FirmwareCacheRecord): Promise<void> {
    this.firmware.set(firmwareKey, rec);
  }
  async getFirmware(firmwareKey: string): Promise<FirmwareCacheRecord | null> {
    return this.firmware.get(firmwareKey) ?? null;
  }

  async setSourceHash(path: string, hash: string): Promise<void> {
    this.sources.set(path, hash);
  }
  async getSourceHash(path: string): Promise<string | null> {
    return this.sources.get(path) ?? null;
  }

  async recordCapability(json: string): Promise<void> {
    this.capability.push({ json, createdAt: Date.now() });
  }
  async latestCapability(): Promise<CapabilitySnapshot | null> {
    return this.capability.length ? this.capability[this.capability.length - 1]! : null;
  }

  async putProjectJson(table: string, projectId: string, json: string): Promise<void> {
    this.projectKv.set(`${table}:${projectId}`, json);
  }
  async getProjectJson(table: string, projectId: string): Promise<string | null> {
    return this.projectKv.get(`${table}:${projectId}`) ?? null;
  }

  async close(): Promise<void> {}
}
