import { isAbsolute, parseFileRef, type FileRef } from "@fleet-console/markdown/file-ref";
import type { PaneTarget } from "../../workspace/shared/pane.js";
import type { OpenFileRequest } from "../../workspace/shared/navigation.js";
import type { FileResolveResult } from "../host/file-resolver.js";
import { theaterOwnerParam } from "../../commodore/client/theater-owner.js";

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

export async function resolveFilePath(theaterId: string, filePath: string, pathKind: OpenFileRequest["pathKind"], signal?: AbortSignal, objectiveId?: string, commodoreId?: string): Promise<FileResolveResult> {
  const response = await fetch("/api/v1/file-explorer/files/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(objectiveId ? { objectiveId } : { theaterId, ...theaterOwnerParam(commodoreId) }), path: filePath, pathKind }), ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new FileNavigationError(response.status === 403 ? "outside_theater" : "not_found");
  return response.json() as Promise<FileResolveResult>;
}

export function filePaneTarget(theaterId: string, resolved: FileResolveResult, location: Pick<FileRef, "line" | "column"> & { readonly anchor?: string } = {}, objectiveId?: string, commodoreId?: string): PaneTarget {
  return {
    paneId: resolved.kind === "dir" ? "file-explorer" : DOCUMENT_PANE_ID,
    theaterId,
    params: {
      theaterId, ...fileRequestOwner(objectiveId, commodoreId), path: resolved.path, pathKind: "theater-relative", requestId: crypto.randomUUID(), preview: "true",
      ...(resolved.kind === "dir" ? { directory: resolved.path } : {}),
      ...(location.line ? { line: String(location.line) } : {}),
      ...(location.column ? { column: String(location.column) } : {}),
      ...(location.anchor ? { anchor: location.anchor } : {}),
    },
  };
}

/**
 * 창 params·표면 문맥에서 파일 요청에 실을 사령관. 착지 params의 사령관은 그 params가
 * 지금 Theater를 가리킬 때만 믿고, 아니면 표면이 소유한 사령관으로 떨어진다. 둘 다
 * 모르면 undefined — 추정하지 않고 서버 거절(기존 실패 알림)에 맡긴다.
 */
export function ownerCommodoreId(
  params: { readonly theaterId?: unknown; readonly commodoreId?: unknown } | undefined,
  theaterId: string | null,
  contextCommodoreId?: string | null,
): string | undefined {
  const fromParams = params?.theaterId === theaterId && typeof params?.commodoreId === "string" && params.commodoreId ? params.commodoreId : undefined;
  if (fromParams) return fromParams;
  return typeof contextCommodoreId === "string" && contextCommodoreId ? contextCommodoreId : undefined;
}

/**
 * 주소·요청 바디에 실을 소유 표식. 목표 문맥이면 objectiveId만, 아니면 아는 경우에만
 * 사령관을 싣는다. 둘 다 모르면 빈 객체 — 서버가 거절하고 기존 실패 알림이 보인다.
 */
export function fileRequestOwner(objectiveId?: string, commodoreId?: string): { readonly objectiveId: string } | { readonly commodoreId: string } | Record<string, never> {
  if (objectiveId) return { objectiveId };
  if (commodoreId) return { commodoreId };
  return {};
}

export async function findReferencedFile(theaterId: string, query: string, signal?: AbortSignal, objectiveId?: string, commodoreId?: string): Promise<{ readonly resolved: FileResolveResult; readonly ref: FileLocation } | null> {
  const ref = parseFileLocation(query);
  if (!ref) return null;
  const explicit = isAbsolute(ref) || ref.line !== undefined || ref.column !== undefined;
  try {
    const resolved = await resolveFilePath(theaterId, ref.path, isAbsolute(ref) ? "absolute" : "theater-relative", signal, objectiveId, commodoreId);
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
