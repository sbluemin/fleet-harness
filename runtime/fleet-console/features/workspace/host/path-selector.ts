import { statSync } from "node:fs";

import type { WorkspacePaths } from "./path-port.js";

/**
 * 화면이 여는 루트. 목표 문맥은 `objectiveId`만, 일반 Theater 탐색은 `theaterId`만 보낸다.
 * 둘을 함께 보내면 거절한다. 목표 위치가 없거나 디렉터리가 사라졌으면 unavailable이다 —
 * Theater 루트로 바꾸지 않는다. 절대 경로는 응답에 싣지 않는다.
 */
export type SurfaceSelectorSource = {
  readonly theaterId?: unknown;
  readonly objectiveId?: unknown;
} | null | undefined;

export type SurfaceRootFailure = {
  readonly ok: false;
  readonly status: 400 | 404;
  readonly error: "ambiguous_selector" | "invalid_request" | "theater_not_found" | "unavailable";
};

export type SurfaceRoot =
  | { readonly ok: true; readonly root: string; readonly key: string }
  | SurfaceRootFailure;

export function conflictingSurfaceSelectors(source: SurfaceSelectorSource): boolean {
  return source?.theaterId !== undefined && source?.objectiveId !== undefined;
}

export function resolveSurfaceRoot(
  paths: Pick<WorkspacePaths, "resolveTheaterPath" | "resolveObjectivePath">,
  source: SurfaceSelectorSource,
): SurfaceRoot {
  if (conflictingSurfaceSelectors(source)) return { ok: false, status: 400, error: "ambiguous_selector" };
  if (typeof source?.objectiveId === "string") {
    if (source.objectiveId.length === 0) return { ok: false, status: 400, error: "invalid_request" };
    const resolved = paths.resolveObjectivePath?.(source.objectiveId) ?? null;
    if (!resolved || !isDirectory(resolved)) return { ok: false, status: 404, error: "unavailable" };
    return { ok: true, root: resolved, key: source.objectiveId };
  }
  if (typeof source?.theaterId === "string") {
    if (source.theaterId.length === 0) return { ok: false, status: 400, error: "invalid_request" };
    const resolved = paths.resolveTheaterPath(source.theaterId);
    if (!resolved) return { ok: false, status: 404, error: "theater_not_found" };
    return { ok: true, root: resolved, key: source.theaterId };
  }
  return { ok: false, status: 400, error: "invalid_request" };
}

export function selectorFromSearch(params: { get(name: string): string | null }): SurfaceSelectorSource {
  const theaterId = params.get("theaterId");
  const objectiveId = params.get("objectiveId");
  return {
    ...(theaterId === null ? {} : { theaterId }),
    ...(objectiveId === null ? {} : { objectiveId }),
  };
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
