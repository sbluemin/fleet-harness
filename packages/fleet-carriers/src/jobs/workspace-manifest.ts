import type { WorkspaceChangeManifest, WorkspaceChangeManifestEntry } from "./types.js";

export interface WorkspaceChangeScanner {
  snapshot(cwd: string): Promise<readonly WorkspaceChangeSnapshotEntry[] | null>;
}

export interface WorkspaceChangeSnapshotEntry {
  readonly status: string;
  readonly path: string;
}

export const WORKSPACE_CHANGE_ATTRIBUTION = "window-approximate";
export const WORKSPACE_CHANGE_LIMIT = 200;
/** baseline에서 dirty였다가 종료 스냅샷에서 사라진 경로의 합성 status — 원복/삭제 탐지용. */
export const WORKSPACE_CHANGE_CLEARED_STATUS = "cleared";

export async function captureWorkspaceSnapshot(
  scanner: WorkspaceChangeScanner | undefined,
  cwd: string,
): Promise<readonly WorkspaceChangeSnapshotEntry[] | null> {
  if (!scanner) return null;
  try {
    return await scanner.snapshot(cwd);
  } catch {
    return null;
  }
}

/** 잡 윈도우 종료 시점 스냅샷을 떠서 baseline과의 차집합 manifest를 만든다 — 단일/Task Force 경로 공용. */
export async function captureJobWindowManifest(
  scanner: WorkspaceChangeScanner | undefined,
  cwd: string,
  baseline: readonly WorkspaceChangeSnapshotEntry[] | null,
): Promise<WorkspaceChangeManifest> {
  if (!scanner) {
    return unavailableWorkspaceManifest("scanner-not-configured");
  }
  const end = await captureWorkspaceSnapshot(scanner, cwd);
  return buildWorkspaceManifest(baseline, end);
}

export function buildWorkspaceManifest(
  baseline: readonly WorkspaceChangeSnapshotEntry[] | null,
  end: readonly WorkspaceChangeSnapshotEntry[] | null,
  reason?: string,
): WorkspaceChangeManifest {
  if (!baseline || !end) {
    return unavailableWorkspaceManifest(reason ?? "snapshot-unavailable");
  }

  const baselineByPath = new Map(baseline.map((entry) => [entry.path, normalizeEntry(entry)]));
  const endChanges = end
    .map(normalizeEntry)
    .filter((entry) => baselineByPath.get(entry.path)?.status !== entry.status);
  // baseline에서 dirty였다가 종료 스냅샷에서 사라진 경로 — 잡 도중 원복·삭제된 변경으로,
  // Artifact Inspection Gate가 주시하는 "무관 파일 되돌림"이 여기에 해당한다.
  const endPaths = new Set(end.map((entry) => entry.path));
  const clearedChanges = [...baselineByPath.values()]
    .filter((entry) => !endPaths.has(entry.path))
    .map((entry) => ({ status: WORKSPACE_CHANGE_CLEARED_STATUS, path: entry.path }));
  const changes = [...endChanges, ...clearedChanges];
  const truncated = changes.length > WORKSPACE_CHANGE_LIMIT;
  const capped = changes.slice(0, WORKSPACE_CHANGE_LIMIT);

  return {
    attribution: WORKSPACE_CHANGE_ATTRIBUTION,
    available: true,
    changes: capped,
    statLine: buildStatLine(changes.length, truncated),
    truncated,
  };
}

export function unavailableWorkspaceManifest(reason: string): WorkspaceChangeManifest {
  return {
    attribution: WORKSPACE_CHANGE_ATTRIBUTION,
    available: false,
    reason,
    changes: [],
    statLine: "unavailable",
    truncated: false,
  };
}

function normalizeEntry(entry: WorkspaceChangeSnapshotEntry): WorkspaceChangeManifestEntry {
  return {
    status: entry.status.trim(),
    path: entry.path,
  };
}

function buildStatLine(changeCount: number, truncated: boolean): string {
  const suffix = changeCount === 1 ? "file" : "files";
  return `${truncated ? `${WORKSPACE_CHANGE_LIMIT}+` : String(changeCount)} ${suffix} (window-approx)`;
}
