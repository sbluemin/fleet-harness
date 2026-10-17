import { isAbsolute, parseFileRef, type FileRef } from "@fleet-console/markdown/file-ref";
import type { PaneTarget } from "@fleet-console/sdk/pane";
import type { OpenFileRequest } from "@fleet-console/sdk/navigation";
import type { FileResolveResult } from "../server/file-resolver.js";

export const DOCUMENT_PANE_ID = "file-explorer-document";

export interface FileLocation extends FileRef { readonly anchor?: string }

export function parseFileLocation(text: string): FileLocation | null {
  const ref = parseFileRef(text);
  if (!ref) return null;
  const hash = ref.path.indexOf("#");
  if (hash < 0) return ref;
  try {
    const anchor = decodeURIComponent(ref.path.slice(hash + 1));
    return { ...ref, path: ref.path.slice(0, hash), ...(anchor ? { anchor } : {}) };
  } catch { return null; }
}

export class FileNavigationError extends Error {
  constructor(readonly reason: "outside_theater" | "not_found") { super(reason); }
}

export async function resolveFilePath(theaterId: string, filePath: string, pathKind: OpenFileRequest["pathKind"], signal?: AbortSignal): Promise<FileResolveResult> {
  const response = await fetch("/plugins/file-explorer/files/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId, path: filePath, pathKind }), ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new FileNavigationError(response.status === 403 ? "outside_theater" : "not_found");
  return response.json() as Promise<FileResolveResult>;
}

export function filePaneTarget(theaterId: string, resolved: FileResolveResult, location: Pick<FileRef, "line" | "column"> & { readonly anchor?: string } = {}): PaneTarget {
  return {
    paneId: resolved.kind === "dir" ? "file-explorer" : DOCUMENT_PANE_ID,
    theaterId,
    params: {
      theaterId, path: resolved.path, pathKind: "theater-relative", requestId: crypto.randomUUID(), preview: "true",
      ...(resolved.kind === "dir" ? { directory: resolved.path } : {}),
      ...(location.line ? { line: String(location.line) } : {}),
      ...(location.column ? { column: String(location.column) } : {}),
      ...(location.anchor ? { anchor: location.anchor } : {}),
    },
  };
}

export async function findReferencedFile(theaterId: string, query: string, signal?: AbortSignal): Promise<{ readonly resolved: FileResolveResult; readonly ref: FileLocation } | null> {
  const ref = parseFileLocation(query);
  if (!ref) return null;
  const explicit = isAbsolute(ref) || ref.line !== undefined || ref.column !== undefined;
  try {
    const resolved = await resolveFilePath(theaterId, ref.path, isAbsolute(ref) ? "absolute" : "theater-relative", signal);
    return { resolved, ref };
  } catch (error) {
    if (explicit || signal?.aborted) throw error;
    return null;
  }
}

export function positiveCoordinate(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
