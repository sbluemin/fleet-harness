export const WORKSPACE_BASE_WIDTH = 312;
export const WORKSPACE_DOCK_DEFAULT_HEIGHT = 230;
export const WORKSPACE_DOCK_MIN_HEIGHT = 160;

export const PREFS_WORKSPACE = "fleet-console.repository.workspace";
export const PREFS_WORKSPACE_DOCK_HEIGHT = "fleet-console.repository.workspace.dockHeight";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkspaceTreeCounts {
  readonly context: number;
  readonly changes: number;
  readonly worktrees: number;
  readonly branches: number;
  readonly tags: number;
  readonly stashes: number;
}

export type WorkspaceTreeSection = {
  readonly id: "context" | "working" | "worktrees" | "branches" | "tags" | "stashes";
  readonly label: "CONTEXT" | "WORKING" | "WORKTREES" | "BRANCHES" | "TAGS" | "STASHES";
  readonly count: number;
};

export function calculateWorkspaceExtraWidth(innerWidth: number, baseWidth = WORKSPACE_BASE_WIDTH): number {
  return Math.max(0, Math.min(1200, innerWidth - 400) - baseWidth);
}

export function readWorkspaceMode(storage?: StorageLike): boolean {
  try { return (storage ?? globalThis.localStorage).getItem(PREFS_WORKSPACE) === "1"; }
  catch { return false; }
}

export function saveWorkspaceMode(enabled: boolean, storage?: StorageLike): void {
  try {
    const target = storage ?? globalThis.localStorage;
    if (enabled) target.setItem(PREFS_WORKSPACE, "1");
    else target.removeItem(PREFS_WORKSPACE);
  } catch { /* best-effort preference */ }
}

export function readWorkspaceDockHeight(storage?: StorageLike): number {
  try {
    const value = Number.parseFloat((storage ?? globalThis.localStorage).getItem(PREFS_WORKSPACE_DOCK_HEIGHT) ?? "");
    if (Number.isFinite(value) && value >= WORKSPACE_DOCK_MIN_HEIGHT) return value;
  } catch { /* best-effort preference */ }
  return WORKSPACE_DOCK_DEFAULT_HEIGHT;
}

export function saveWorkspaceDockHeight(height: number, storage?: StorageLike): void {
  try { (storage ?? globalThis.localStorage).setItem(PREFS_WORKSPACE_DOCK_HEIGHT, String(height)); }
  catch { /* best-effort preference */ }
}

export function normalizeWorkspaceDockHeight(storedHeight: number, containerHeight: number): number {
  const maximum = containerHeight - 180 - 4;
  if (maximum <= WORKSPACE_DOCK_MIN_HEIGHT) return Math.max(0, maximum);
  return Math.max(WORKSPACE_DOCK_MIN_HEIGHT, Math.min(maximum, storedHeight));
}

export function clampWorkspaceDockHeight(startHeight: number, pointerDeltaY: number, containerHeight: number): number | null {
  const maximum = containerHeight - 180 - 4;
  if (maximum < WORKSPACE_DOCK_MIN_HEIGHT) return null;
  return Math.max(WORKSPACE_DOCK_MIN_HEIGHT, Math.min(maximum, startHeight - pointerDeltaY));
}

export function buildWorkspaceDockTemplate(dockHeight: number): string {
  return `minmax(180px, 1fr) 4px ${dockHeight}px`;
}

export function buildWorkspaceTreeSections(counts: WorkspaceTreeCounts): readonly WorkspaceTreeSection[] {
  return [
    { id: "context", label: "CONTEXT", count: counts.context },
    { id: "working", label: "WORKING", count: counts.changes },
    { id: "worktrees", label: "WORKTREES", count: counts.worktrees },
    { id: "branches", label: "BRANCHES", count: counts.branches },
    { id: "tags", label: "TAGS", count: counts.tags },
    { id: "stashes", label: "STASHES", count: counts.stashes },
  ];
}
