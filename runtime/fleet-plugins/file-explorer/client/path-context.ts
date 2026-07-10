import type { FolderEntry, FolderListResult } from "../server/types.js";

export function contextKey(theaterId: string | null, relPath: string | null): string {
  return `${theaterId ?? ""}:${relPath ?? ""}`;
}

export function prefixContextPath(contextRelPath: string | null, relativePath: string): string | null {
  const normalized = normalize(relativePath);
  if (normalized === null) return null;
  const prefix = contextRelPath ? normalize(contextRelPath) : "";
  if (prefix === null) return null;
  return prefix ? (normalized ? `${prefix}/${normalized}` : prefix) : normalized;
}

export function stripContextPath(contextRelPath: string | null, theaterRelativePath: string): string | null {
  const value = normalize(theaterRelativePath);
  const prefix = contextRelPath ? normalize(contextRelPath) : "";
  if (value === null || prefix === null) return null;
  if (!prefix) return value;
  if (value === prefix) return "";
  return value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : null;
}

export function adaptFolderList(contextRelPath: string | null, result: FolderListResult): FolderListResult | null {
  const relativePath = stripContextPath(contextRelPath, result.relativePath);
  if (relativePath === null) return null;
  const parentRelativePath = result.parentRelativePath === null ? null : stripContextPath(contextRelPath, result.parentRelativePath);
  if (result.parentRelativePath !== null && parentRelativePath === null) return null;
  const entries: FolderEntry[] = [];
  for (const entry of result.entries) {
    const entryPath = stripContextPath(contextRelPath, entry.relativePath);
    if (entryPath !== null) entries.push({ ...entry, relativePath: entryPath });
  }
  return { ...result, relativePath, parentRelativePath, entries };
}

export function translateContextEvent(contextRelPath: string | null, theaterRelativePath: string): string | null {
  return stripContextPath(contextRelPath, theaterRelativePath);
}

function normalize(value: string): string | null {
  if (value.includes("\0") || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return null;
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.join("/");
}
