/**
 * Minimal ZIP reader — extracts a library .zip entirely in the browser (invariant: self-host, no
 * third-party script). Parses the End-Of-Central-Directory + central directory and inflates each entry
 * with the platform `DecompressionStream('deflate-raw')` (Chromium + Node 18+) — no dependency. Handles
 * the only two methods real Arduino library zips use: stored (0) and deflate (8).
 *
 * Hardened (AUD-020): file-count + per-entry + total uncompressed-size + compression-ratio limits (zip
 * bomb), header-offset bounds checks, and path-traversal rejection on an untrusted upload.
 */
export interface ZipEntry {
  /** Full path within the archive (forward slashes), e.g. "MyLib/src/MyLib.h". */
  name: string;
  bytes: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

const MAX_FILES = 4000;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024; // 16 MiB per file (uncompressed)
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB total (uncompressed)
const MAX_RATIO = 1000; // reject an entry that inflates > 1000× its compressed size (a classic zip bomb)

/** Reject a path that escapes the mount namespace or carries control chars (AUD-020); returns a safe,
 *  forward-slash path or throws. */
export function safeZipName(name: string): string {
  const n = name.replace(/\\/g, '/');
  for (let i = 0; i < n.length; i++) {
    if (n.charCodeAt(i) < 0x20)
      throw new Error(`Tên file trong .zip chứa ký tự điều khiển: "${name}".`);
  }
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n))
    throw new Error(`Tên file .zip là đường dẫn tuyệt đối: "${name}".`);
  if (n.split('/').some((seg) => seg === '..'))
    throw new Error(`Tên file .zip thoát thư mục (..): "${name}".`);
  return n;
}

/** A Blob over an exact copy in a plain ArrayBuffer (avoids the SharedArrayBuffer-backed view that the
 *  COOP/COEP build widens typed-array buffers to, which the Blob/BlobPart types reject). */
export function blobOf(data: Uint8Array): Blob {
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  return new Blob([ab]);
}

/** Inflate a raw DEFLATE buffer via the platform stream API, capped so an entry can't expand unbounded. */
async function inflateRaw(data: Uint8Array, cap: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = blobOf(data).stream().pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length > cap)
    throw new Error('Một file trong .zip giải nén quá lớn (nghi ngờ zip bomb).');
  return out;
}

/** Find the End-Of-Central-Directory record (scans back over the optional trailing comment). */
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/** Parse a ZIP archive into its file entries (directories skipped). Throws on a malformed/abusive archive. */
export async function unzip(zip: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('Không phải file .zip hợp lệ (thiếu EOCD).');
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_FILES) throw new Error(`File .zip có quá nhiều mục (${count} > ${MAX_FILES}).`);
  let p = view.getUint32(eocd + 16, true); // central directory offset

  const td = new TextDecoder();
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== CDH_SIG)
      throw new Error('Cấu trúc .zip hỏng (central directory).');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > zip.length)
      throw new Error('Cấu trúc .zip hỏng (tên file vượt ngoài file).');
    const rawName = td.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue; // directory entry
    const name = safeZipName(rawName); // reject traversal / absolute path / control chars
    // Data lives after the LOCAL header (its name/extra lengths can differ from the central one).
    if (localOff + 30 > zip.length)
      throw new Error('Cấu trúc .zip hỏng (local header vượt ngoài file).');
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > zip.length)
      throw new Error('Cấu trúc .zip hỏng (dữ liệu vượt ngoài file).');
    const raw = zip.subarray(dataStart, dataStart + compSize);
    const bytes =
      method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw, MAX_ENTRY_BYTES) : null;
    if (!bytes) throw new Error(`Phương thức nén .zip chưa hỗ trợ (${method}) cho "${name}".`);
    if (bytes.length > MAX_ENTRY_BYTES) throw new Error(`File "${name}" trong .zip quá lớn.`);
    if (compSize > 0 && bytes.length / compSize > MAX_RATIO)
      throw new Error(`File "${name}" nén bất thường (nghi ngờ zip bomb).`);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Tổng dung lượng .zip giải nén vượt giới hạn.');
    entries.push({ name, bytes });
  }
  return entries;
}
