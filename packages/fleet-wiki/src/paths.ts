import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  ARCHIVE_DIRNAME,
  CONFLICTS_DIRNAME,
  INDEX_FILENAME,
  INDEX_MD_FILENAME,
  KNOWLEDGE_ROOT_DIRNAME,
  LOG_MD_FILENAME,
  QUEUE_DIRNAME,
  RAW_DIRNAME,
  SCHEMA_DIRNAME,
  WIKI_DIRNAME,
} from "./patch.js";
import { ensureWorkspaceDoctrine, ensureWorkspaceSchema } from "./schema.js";
import type { MemoryPaths } from "./types.js";

export function resolveMemoryPaths(cwd: string): MemoryPaths {
  return createMemoryPaths(path.join(cwd, KNOWLEDGE_ROOT_DIRNAME));
}

/** Build paths for an already-selected knowledge root. */
export function createMemoryPaths(root: string): MemoryPaths {
  return {
    root,
    rawDir: path.join(root, RAW_DIRNAME),
    wikiDir: path.join(root, WIKI_DIRNAME),
    schemaDir: path.join(root, SCHEMA_DIRNAME),
    queueDir: path.join(root, QUEUE_DIRNAME),
    archiveDir: path.join(root, ARCHIVE_DIRNAME),
    conflictsDir: path.join(root, CONFLICTS_DIRNAME),
    indexFile: path.join(root, INDEX_FILENAME),
  };
}

/** Retains direct-library callers while registered tools receive injected paths. */
export function resolveToolMemoryPaths(ctx: { cwd: string; paths?: MemoryPaths }): MemoryPaths {
  return ctx.paths ?? resolveMemoryPaths(ctx.cwd);
}

export async function ensureMemoryRoot(paths: MemoryPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.rawDir, { recursive: true });
  await mkdir(paths.wikiDir, { recursive: true });
  await mkdir(paths.schemaDir, { recursive: true });
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.archiveDir, { recursive: true });
  await mkdir(paths.conflictsDir, { recursive: true });
  await ensureWorkspaceSchema(paths);
  await ensureWorkspaceDoctrine(paths);
}

export function getIndexMarkdownFile(paths: MemoryPaths): string {
  return path.join(paths.wikiDir, INDEX_MD_FILENAME);
}

export function getLogFile(paths: MemoryPaths): string {
  return path.join(paths.root, LOG_MD_FILENAME);
}
