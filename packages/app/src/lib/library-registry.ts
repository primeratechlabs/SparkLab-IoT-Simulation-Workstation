/**
 * Arduino Library Manager — search + download from the official registry, client-side (no backend). The
 * index (downloads.arduino.cc/.../library_index.json.gz) and the library .zip downloads are served with
 * `Access-Control-Allow-Origin: *`, so the browser fetches them directly; the gzip is inflated with the
 * platform DecompressionStream. The index is fetched once per session and cached in memory.
 *
 * Caveat (surfaced in the UI): the simulator runs a minimal HAL, so many registry libraries — especially
 * those calling chip/RTOS APIs — won't compile here. The build error says which symbol is missing.
 */
export interface RegistryLib {
  name: string;
  version: string;
  author: string;
  sentence: string;
  architectures: string[];
  /** The .zip download URL (on downloads.arduino.cc, CORS-enabled). */
  url: string;
  size: number;
}

const INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json.gz';

/** Compare dotted versions numerically (1.10.0 > 1.9.9); non-numeric parts compared lexically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

interface RawEntry {
  name: string;
  version: string;
  author?: string;
  sentence?: string;
  architectures?: string[];
  url: string;
  size?: number;
}

/** Parse the raw index JSON into one entry per library (the latest version). */
export function parseIndex(json: { libraries?: RawEntry[] }): RegistryLib[] {
  const byName = new Map<string, RegistryLib>();
  for (const l of json.libraries ?? []) {
    if (!l.name || !l.url) continue;
    const lib: RegistryLib = {
      name: l.name,
      version: l.version,
      author: l.author ?? '',
      sentence: l.sentence ?? '',
      architectures: l.architectures ?? [],
      url: l.url,
      size: l.size ?? 0,
    };
    const prev = byName.get(l.name);
    if (!prev || compareVersions(l.version, prev.version) > 0) byName.set(l.name, lib);
  }
  return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** Filter the registry by a query against name + description (capped for the UI). */
export function searchRegistry(libs: RegistryLib[], query: string, limit = 40): RegistryLib[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = libs.filter(
    (l) => l.name.toLowerCase().includes(q) || l.sentence.toLowerCase().includes(q),
  );
  // exact/prefix name matches first
  hits.sort((a, b) => rank(a.name.toLowerCase(), q) - rank(b.name.toLowerCase(), q));
  return hits.slice(0, limit);
}
const rank = (name: string, q: string): number => (name === q ? 0 : name.startsWith(q) ? 1 : 2);

type FetchFn = typeof fetch;
let cache: RegistryLib[] | null = null;
let inflight: Promise<RegistryLib[]> | null = null;

/** Fetch + inflate + parse the registry index (cached in memory for the session). `fetchImpl` is
 *  injectable for tests. */
export async function loadRegistry(fetchImpl: FetchFn = fetch): Promise<RegistryLib[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = (async () => {
      const res = await fetchImpl(INDEX_URL);
      if (!res.ok || !res.body)
        throw new Error(`Không tải được danh mục thư viện (HTTP ${res.status}).`);
      const json = (await new Response(
        res.body.pipeThrough(new DecompressionStream('gzip')),
      ).json()) as { libraries?: RawEntry[] };
      cache = parseIndex(json);
      return cache;
    })().catch((e) => {
      inflight = null; // AUD-017: a rejected fetch must NOT stick — clear so the next call retries
      throw e;
    });
  }
  return inflight;
}

/** Hosts the library .zip may be downloaded from (CORS-enabled Arduino mirrors). A registry entry whose
 *  URL points elsewhere is rejected — the index is fetched over the network, so don't trust its URLs. */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'downloads.arduino.cc',
  'github.com',
  'codeload.github.com',
]);
const MAX_LIBRARY_BYTES = 32 * 1024 * 1024; // 32 MiB hard cap on a downloaded archive

/** Download a library's .zip bytes after validating its URL scheme/host + declared size (AUD-017). */
export async function downloadLibrary(
  lib: RegistryLib,
  fetchImpl: FetchFn = fetch,
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(lib.url);
  } catch {
    throw new Error(`URL thư viện "${lib.name}" không hợp lệ.`);
  }
  if (url.protocol !== 'https:') throw new Error(`"${lib.name}" không dùng HTTPS — từ chối tải.`);
  if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname))
    throw new Error(`"${lib.name}" tải từ host không tin cậy (${url.hostname}).`);
  if (lib.size && lib.size > MAX_LIBRARY_BYTES)
    throw new Error(`"${lib.name}" quá lớn (${(lib.size / 1048576).toFixed(1)} MB).`);
  const res = await fetchImpl(lib.url);
  if (!res.ok) throw new Error(`Không tải được "${lib.name}" (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_LIBRARY_BYTES)
    throw new Error(`"${lib.name}" vượt giới hạn ${MAX_LIBRARY_BYTES / 1048576} MB.`);
  return bytes;
}
