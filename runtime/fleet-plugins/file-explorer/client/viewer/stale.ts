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

export function hasEntry(entries: readonly FolderEntry[], relativePath: string): boolean {
  return entries.some((item) => item.relativePath === relativePath);
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
  /** 목록이 상한에 잘렸으면 "행이 없다"가 "파일이 없다"를 뜻하지 않는다. */
  readonly truncated?: boolean;
}): readonly string[] {
  const dir = normalizeRelativeDir(input.relativeDir);
  const stale: string[] = [];
  for (const path of input.openPaths) {
    if (parentDirOf(path) !== dir) continue;
    // 사라진 파일(삭제·이름 변경)도 낡음이다 — mtime이 없다고 "최신"이라 말하면
    // 존재하지 않는 경로의 내용을 아무 표식 없이 계속 보여주게 된다.
    if (input.truncated !== true && !hasEntry(input.entries, path)) {
      stale.push(path);
      continue;
    }
    const diskMtime = findEntryMtimeMs(input.entries, path);
    if (isLoadedDocumentStale(input.loadedMtimeByPath.get(path), diskMtime)) {
      stale.push(path);
    }
  }
  return stale;
}
