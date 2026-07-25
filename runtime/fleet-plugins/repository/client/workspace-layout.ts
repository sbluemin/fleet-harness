import type { Translate } from "@fleet-console/sdk/i18n";

import type { RepositoryMessageKey } from "./i18n/messages.js";

export const WORKSPACE_DOCK_DEFAULT_HEIGHT = 230;
export const WORKSPACE_DOCK_MIN_HEIGHT = 160;
export const WORKSPACE_TREE_DEFAULT_WIDTH = 222;
export const WORKSPACE_TREE_MIN_WIDTH = 148;
export const WORKSPACE_TREE_DIVIDER_WIDTH = 4;
// 트리를 줄여도 중앙(History/Changes) 영역이 유의미하게 남도록 하는 최소 보장 폭.
export const WORKSPACE_MAIN_MIN_WIDTH = 180;

export const PREFS_WORKSPACE_DOCK_HEIGHT = "fleet-console.repository.workspace.dockHeight";
export const PREFS_WORKSPACE_TREE_WIDTH = "fleet-console.repository.workspace.treeWidth";

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
  readonly label: string;
  readonly count: number;
};

const SECTION_LABEL_KEY: Record<WorkspaceTreeSection["id"], RepositoryMessageKey> = {
  context: "repository.section.context",
  working: "repository.section.working",
  worktrees: "repository.section.worktrees",
  branches: "repository.section.branches",
  tags: "repository.section.tags",
  stashes: "repository.section.stashes",
};

export function readWorkspaceTreeWidth(storage?: StorageLike): number {
  try {
    const value = Number.parseFloat((storage ?? globalThis.localStorage).getItem(PREFS_WORKSPACE_TREE_WIDTH) ?? "");
    if (Number.isFinite(value) && value >= WORKSPACE_TREE_MIN_WIDTH) return value;
  } catch { /* best-effort preference */ }
  return WORKSPACE_TREE_DEFAULT_WIDTH;
}

export function saveWorkspaceTreeWidth(width: number, storage?: StorageLike): void {
  try { (storage ?? globalThis.localStorage).setItem(PREFS_WORKSPACE_TREE_WIDTH, String(width)); }
  catch { /* best-effort preference */ }
}

export function clampWorkspaceTreeWidth(startWidth: number, pointerDeltaX: number, containerWidth: number): number | null {
  const maximum = containerWidth - WORKSPACE_MAIN_MIN_WIDTH - WORKSPACE_TREE_DIVIDER_WIDTH;
  if (maximum < WORKSPACE_TREE_MIN_WIDTH) return null;
  return Math.max(WORKSPACE_TREE_MIN_WIDTH, Math.min(maximum, startWidth + pointerDeltaX));
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

export function buildWorkspaceTreeSections(
  counts: WorkspaceTreeCounts,
  t: Translate<RepositoryMessageKey>,
): readonly WorkspaceTreeSection[] {
  return [
    { id: "context", label: t(SECTION_LABEL_KEY.context), count: counts.context },
    { id: "working", label: t(SECTION_LABEL_KEY.working), count: counts.changes },
    { id: "worktrees", label: t(SECTION_LABEL_KEY.worktrees), count: counts.worktrees },
    { id: "branches", label: t(SECTION_LABEL_KEY.branches), count: counts.branches },
    { id: "tags", label: t(SECTION_LABEL_KEY.tags), count: counts.tags },
    { id: "stashes", label: t(SECTION_LABEL_KEY.stashes), count: counts.stashes },
  ];
}
