/**
 * Project persistence over the OPFS virtual filesystem — save/load/list/delete circuit documents.
 * This is the foundation the drag-drop UI autosaves to (Stage 7 sync/autosave); `saveProject` stamps
 * `modifiedAt` so last-write-wins ordering is meaningful, and `listProjects` returns summaries newest
 * first. Foreign/corrupt files in the projects directory are skipped, never fatal.
 */
import type { VirtualFs } from '@sparklab/opfs';
import type { CircuitDocument } from './types.js';
import { serializeDocument, parseDocument } from './serialize.js';

const PROJECTS_DIR = '/projects';
const filePath = (id: string): string => `${PROJECTS_DIR}/${id}.json`;

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
}

/** Persist a document (autosave-friendly). `now` stamps `modifiedAt`; returns the stored document. */
export async function saveProject(
  fs: VirtualFs,
  doc: CircuitDocument,
  opts: { now?: number } = {},
): Promise<CircuitDocument> {
  await fs.mkdirp(PROJECTS_DIR);
  const stamped = opts.now !== undefined ? { ...doc, modifiedAt: opts.now } : doc;
  await fs.writeFile(filePath(doc.id), serializeDocument(stamped));
  return stamped;
}

export async function loadProject(fs: VirtualFs, id: string): Promise<CircuitDocument> {
  return parseDocument(await fs.readFileText(filePath(id)));
}

export async function projectExists(fs: VirtualFs, id: string): Promise<boolean> {
  return fs.exists(filePath(id));
}

export async function deleteProject(fs: VirtualFs, id: string): Promise<void> {
  if (await fs.exists(filePath(id))) await fs.remove(filePath(id));
}

/** Project summaries, most-recently-modified first; skips unreadable/foreign files. */
export async function listProjects(fs: VirtualFs): Promise<ProjectSummary[]> {
  if (!(await fs.exists(PROJECTS_DIR))) return [];
  const names = await fs.list(PROJECTS_DIR);
  const out: ProjectSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const doc = parseDocument(await fs.readFileText(`${PROJECTS_DIR}/${name}`));
      out.push({
        id: doc.id,
        name: doc.name,
        createdAt: doc.createdAt,
        modifiedAt: doc.modifiedAt,
      });
    } catch {
      // skip corrupt or foreign files in the projects directory
    }
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}
