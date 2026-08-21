import type { FolderEntry } from "../../server/types.js";

/** Theater-relative parent directory — no trailing slash, "" at the root. */
export function parentDirOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
}

export function normalizeRelativeDir(relativeDir: string): string {
  return relativeDir.replace(/\/+$/, "");
}

/** True when a listed entry's mtime differs from the mtime the document was loaded with. */
export function isLoadedDocumentStale(
  loadedMtimeMs: number | undefined,
  diskMtimeMs: number | undefined,
): boolean {
  if (loadedMtimeMs === undefined || diskMtimeMs === undefined) return false;
  return loadedMtimeMs !== diskMtimeMs;
}

export function findEntryMtimeMs(
  entries: readonly FolderEntry[],
  relativePath: string,
): number | undefined {
  const entry = entries.find((item) => item.relativePath === relativePath);
  return entry?.mtimeMs;
}

export function loadedMtimeOf(viewState: { kind: string; mtimeMs?: number } | undefined): number | undefined {
  if (!viewState || (viewState.kind !== "code" && viewState.kind !== "image")) return undefined;
  return viewState.mtimeMs;
}

/**
 * After a successful files/list, mark open documents whose parent dir was
 * refreshed and whose disk mtime no longer matches the loaded mtime.
 */
export function stalePathsAfterRefresh(input: {
  readonly relativeDir: string;
  readonly entries: readonly FolderEntry[];
  readonly openPaths: readonly string[];
  readonly loadedMtimeByPath: ReadonlyMap<string, number | undefined>;
}): readonly string[] {
  const dir = normalizeRelativeDir(input.relativeDir);
  const stale: string[] = [];
  for (const path of input.openPaths) {
    if (parentDirOf(path) !== dir) continue;
    const diskMtime = findEntryMtimeMs(input.entries, path);
    if (isLoadedDocumentStale(input.loadedMtimeByPath.get(path), diskMtime)) {
      stale.push(path);
    }
  }
  return stale;
}
