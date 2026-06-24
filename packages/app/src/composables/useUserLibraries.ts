/**
 * useUserLibraries — the user's uploaded Arduino libraries (.zip), parsed client-side and pushed to the
 * build worker so a sketch can `#include` them. Persisted in localStorage so they survive a reload. The
 * worker is the source of truth at build time (setUserLibraries); this composable keeps it in sync.
 *
 * Note: the simulator runs a minimal HAL, so a library that calls APIs the shim doesn't provide will
 * fail at compile/link — surfaced as a normal build error, not hidden here.
 */
import { ref, onMounted } from 'vue';
import { getBuild } from '../lib/build-client';
import { unzip } from '../lib/unzip';
import {
  parseArduinoLibrary,
  isBuiltInLibrary,
  BUILT_IN_LIB_NAMES,
  type UserLibrary,
} from '../lib/arduino-library';
import {
  loadRegistry,
  searchRegistry,
  downloadLibrary,
  type RegistryLib,
} from '../lib/library-registry';

const STORAGE_KEY = 'sparklab:user-libraries';

function load(): UserLibrary[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UserLibrary[]) : [];
  } catch {
    return [];
  }
}

/** Plain (non-reactive) clone for Comlink — Vue proxies can't be structured-cloned. */
const plain = (libs: UserLibrary[]): UserLibrary[] =>
  JSON.parse(JSON.stringify(libs)) as UserLibrary[];

export interface AddResult {
  ok: boolean;
  name?: string;
  error?: string;
}

export function useUserLibraries() {
  const libraries = ref<UserLibrary[]>(load());
  const busy = ref(false);

  // Transactional commit (AUD-019): persist + push to the build worker BEFORE mutating the visible state,
  // so the UI never shows "installed" for a library the compiler doesn't actually have. A quota failure
  // throws (it is NOT swallowed) and the visible state is left unchanged.
  async function commit(next: UserLibrary[]): Promise<void> {
    const libs = plain(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(libs));
    } catch {
      throw new Error(
        'Bộ nhớ trình duyệt đã đầy — không lưu được thư viện. Hãy xoá bớt thư viện rồi thử lại.',
      );
    }
    await getBuild().setUserLibraries(libs); // worker is the build source of truth
    libraries.value = next; // commit only after BOTH persistence and worker sync succeeded
  }

  // Restore persisted libraries into the worker before the first build (only if any — no eager worker
  // creation for the common no-library case).
  onMounted(() => {
    if (libraries.value.length) void getBuild().setUserLibraries(plain(libraries.value));
  });

  /** Unzip + parse + add (or replace a same-named) library; pushes to the build worker. */
  async function installBytes(bytes: Uint8Array): Promise<AddResult> {
    const entries = await unzip(bytes);
    const lib = parseArduinoLibrary(entries);
    if (!lib) return { ok: false, error: 'File .zip không chứa mã thư viện C/C++ (.h/.cpp).' };
    if (isBuiltInLibrary(lib.provides)) {
      return {
        ok: false,
        error: `Trình mô phỏng đã tích hợp sẵn "${lib.name}" (qua HTTP). Dùng #include trực tiếp, không cần cài.`,
      };
    }
    const next = [...libraries.value.filter((l) => l.name !== lib.name), lib];
    try {
      await commit(next);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Không cài được thư viện.' };
    }
    return { ok: true, name: lib.name };
  }

  /** Parse + install a .zip the user picked/dropped. */
  async function addZip(file: File): Promise<AddResult> {
    busy.value = true;
    try {
      return await installBytes(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Không đọc được file .zip.' };
    } finally {
      busy.value = false;
    }
  }

  async function remove(name: string): Promise<AddResult> {
    const next = libraries.value.filter((l) => l.name !== name);
    try {
      await commit(next); // only drop it from the UI once the worker + storage agree (AUD-019)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Không gỡ được thư viện.' };
    }
    return { ok: true, name };
  }

  // ── Library Manager (online registry) ──────────────────────────────────────────────────────────
  const results = ref<RegistryLib[]>([]);
  const searching = ref(false);
  const registryError = ref<string | null>(null);

  /** Search the Arduino registry (fetches + caches the index on first use). A generation guard (AUD-017)
   *  drops a stale result if a newer search started during the await — so the visible list always matches
   *  the latest query. */
  let searchGen = 0;
  async function search(query: string): Promise<void> {
    const myGen = ++searchGen;
    registryError.value = null;
    if (!query.trim()) {
      results.value = [];
      return;
    }
    searching.value = true;
    try {
      const found = searchRegistry(await loadRegistry(), query);
      if (myGen === searchGen) results.value = found; // only the latest query may commit results
    } catch (e) {
      if (myGen === searchGen) {
        registryError.value = e instanceof Error ? e.message : 'Không tải được danh mục.';
        results.value = [];
      }
    } finally {
      if (myGen === searchGen) searching.value = false;
    }
  }

  /** Download a registry library's .zip and install it (same path as an upload). */
  async function install(lib: RegistryLib): Promise<AddResult> {
    if (BUILT_IN_LIB_NAMES.has(lib.name.toLowerCase())) {
      return {
        ok: false,
        error: `"${lib.name}" đã tích hợp sẵn trong trình mô phỏng (qua HTTP). Dùng #include <BlynkSimpleWifi.h> trực tiếp.`,
      };
    }
    busy.value = true;
    try {
      return await installBytes(await downloadLibrary(lib));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : `Không cài được "${lib.name}".` };
    } finally {
      busy.value = false;
    }
  }

  return { libraries, busy, addZip, remove, results, searching, registryError, search, install };
}
