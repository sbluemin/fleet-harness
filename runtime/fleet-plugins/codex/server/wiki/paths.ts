import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { ensureWorkspaceDoctrine, ensureWorkspaceSchema } from "./schema.js";
import type { MemoryPaths } from "./types.js";

export const KNOWLEDGE_ROOT_DIRNAME = ".fleet/knowledge";
export const RAW_DIRNAME = "raw";
export const WIKI_DIRNAME = "wiki";
export const SCHEMA_DIRNAME = "schema";
export const INDEX_FILENAME = "index.json";
export const INDEX_MD_FILENAME = "index.md";
export const LOG_MD_FILENAME = "log.md";
export const REQUIRED_WIKI_FRONTMATTER_KEYS = ["id", "title", "tags", "created", "updated", "version"] as const;

export function resolveMemoryPaths(cwd: string): MemoryPaths {
  return createMemoryPaths(path.join(cwd, KNOWLEDGE_ROOT_DIRNAME));
}

/** Build paths for an already-selected knowledge root. */
export function createMemoryPaths(root: string): MemoryPaths {
  root = path.resolve(root);
  return {
    root,
    rawDir: path.join(root, RAW_DIRNAME),
    wikiDir: path.join(root, WIKI_DIRNAME),
    schemaDir: path.join(root, SCHEMA_DIRNAME),
    historyDir: path.join(root, "history"),
    indexFile: path.join(root, INDEX_FILENAME),
  };
}

/** Retains direct-library callers while registered tools receive injected paths. */
export function resolveToolMemoryPaths(ctx: { cwd: string; paths?: MemoryPaths }): MemoryPaths {
  return ctx.paths ?? resolveMemoryPaths(ctx.cwd);
}

/** Reject lexical escapes and every symlink component, including the final file. */
export async function assertContainedPath(paths: MemoryPaths, relative: string): Promise<void> {
  if (!relative || relative.includes("\\") || path.posix.normalize(relative) !== relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split("/").some(part => part === "." || part === "..")) throw new Error("unsafe wiki path");
  const root = await realpath(paths.root);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (!current.startsWith(`${root}${path.sep}`)) throw new Error("wiki path escapes root");
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("wiki path must not include symlink path components");
      const resolved = await realpath(current);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("wiki path escapes root");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function ensureMemoryRoot(paths: MemoryPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  for (const dir of [RAW_DIRNAME, WIKI_DIRNAME, SCHEMA_DIRNAME, "history"]) {
    await assertContainedPath(paths, dir);
    await mkdir(path.join(paths.root, dir), { recursive: true });
  }
  await ensureWorkspaceSchema(paths);
  await ensureWorkspaceDoctrine(paths);
}

export function getIndexMarkdownFile(paths: MemoryPaths): string {
  return path.join(paths.wikiDir, INDEX_MD_FILENAME);
}

export function getLogFile(paths: MemoryPaths): string {
  return path.join(paths.root, LOG_MD_FILENAME);
}
