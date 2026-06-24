/**
 * OPFS layout constants — REFERENCE-SPEC §10.
 *
 * The OPFS root acts as the virtual disk. Every artifact path is content-addressed
 * (sha256) under build/* (invariant I5). These are *logical* paths relative to the
 * OPFS root directory handle; segments map to nested FileSystemDirectoryHandles.
 */

export const OPFS_LAYOUT = {
  system: {
    dir: 'system',
    appVersion: 'system/app-version.json',
    capabilityProfile: 'system/capability-profile.json',
    packRegistry: 'system/pack-registry.json',
  },
  packs: {
    dir: 'packs',
    toolchains: 'packs/toolchains',
    sdk: 'packs/sdk',
    emulators: 'packs/emulators',
    components: 'packs/components',
    boards: 'packs/boards',
  },
  workspace: {
    dir: 'workspace',
    projects: 'workspace/projects',
  },
  build: {
    dir: 'build',
    objects: 'build/objects',
    archives: 'build/archives',
    firmware: 'build/firmware',
    maps: 'build/maps',
    logs: 'build/logs',
  },
  cache: {
    dir: 'cache',
    wasmModules: 'cache/wasm-modules',
    decompressedPacks: 'cache/decompressed-packs',
    parsedHeaders: 'cache/parsed-headers',
    dependencyGraphs: 'cache/dependency-graphs',
    preprocessedSources: 'cache/preprocessed-sources',
  },
  db: {
    dir: 'db',
    buildIndex: 'db/build-index.sqlite',
  },
} as const;

export type PackTypeDir = 'toolchains' | 'sdk' | 'emulators' | 'components' | 'boards';

const PACK_TYPE_DIR: Record<string, string> = {
  toolchain: OPFS_LAYOUT.packs.toolchains,
  sdk: OPFS_LAYOUT.packs.sdk,
  emulator: OPFS_LAYOUT.packs.emulators,
  component: OPFS_LAYOUT.packs.components,
  board: OPFS_LAYOUT.packs.boards,
};

/** Directory under which a pack of the given PackType installs. */
export function packDirFor(packType: string): string {
  const dir = PACK_TYPE_DIR[packType];
  if (!dir) throw new Error(`unknown pack type: ${packType}`);
  return dir;
}

/** Installed pack root path, e.g. packs/toolchains/<name>@<version>. */
export function packInstallPath(packType: string, name: string, version: string): string {
  return `${packDirFor(packType)}/${name}@${version}`;
}

export function objectPath(objectKeyBare: string): string {
  return `${OPFS_LAYOUT.build.objects}/${objectKeyBare}.o`;
}

export function firmwarePath(firmwareKeyBare: string, ext: 'elf' | 'bin' | 'hex' | 'uf2'): string {
  return `${OPFS_LAYOUT.build.firmware}/${firmwareKeyBare}.${ext}`;
}

/** All directories that should exist on a freshly initialized disk. */
export function bootstrapDirs(): string[] {
  return [
    OPFS_LAYOUT.system.dir,
    OPFS_LAYOUT.packs.dir,
    OPFS_LAYOUT.packs.toolchains,
    OPFS_LAYOUT.packs.sdk,
    OPFS_LAYOUT.packs.emulators,
    OPFS_LAYOUT.packs.components,
    OPFS_LAYOUT.packs.boards,
    OPFS_LAYOUT.workspace.dir,
    OPFS_LAYOUT.workspace.projects,
    OPFS_LAYOUT.build.dir,
    OPFS_LAYOUT.build.objects,
    OPFS_LAYOUT.build.archives,
    OPFS_LAYOUT.build.firmware,
    OPFS_LAYOUT.build.maps,
    OPFS_LAYOUT.build.logs,
    OPFS_LAYOUT.cache.dir,
    OPFS_LAYOUT.cache.wasmModules,
    OPFS_LAYOUT.cache.decompressedPacks,
    OPFS_LAYOUT.cache.parsedHeaders,
    OPFS_LAYOUT.cache.dependencyGraphs,
    OPFS_LAYOUT.cache.preprocessedSources,
    OPFS_LAYOUT.db.dir,
  ];
}
