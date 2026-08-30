import type { Translate } from "@fleet-console/sdk/i18n";

import type { RepositoryMessageKey } from "./i18n/index.js";

export const WORKSPACE_DOCK_DEFAULT_HEIGHT = 230;
const WORKSPACE_DOCK_MIN_HEIGHT = 160;
// 소스 트리 열의 폭은 이제 표면이 소유한다 — 분할선·클램프·기억은 호스트의 페인 기하가 진다.

// 검사기 독(파일 목록 ⇔ diff)의 폭 축. 저장값은 CSS 변수로만 주입한다 — 인라인
// grid-template-columns는 좁은 독을 세로 스택으로 바꾸는 컨테이너 쿼리를 이겨버려
// main 열 0 붕괴(PR#516에서 고친 선존 결함)를 되살린다.
export const WORKSPACE_DOCK_FILES_DEFAULT_WIDTH = 250;
export const WORKSPACE_DOCK_FILES_MIN_WIDTH = 150;
export const WORKSPACE_DOCK_DIVIDER_WIDTH = 4;
// diff 열의 최소 폭. CSS의 calc(100% - …) 보정값과 반드시 같은 값이어야 한다.
// 독 메타 헤더는 고정 버튼들 때문에 오른쪽 210px를 비워 두므로, 그보다 넉넉해야 제목이 남는다.
export const WORKSPACE_DOCK_MAIN_MIN_WIDTH = 340;
// 두 최소폭과 디바이더가 모두 들어가는 최소 독 폭. 이보다 좁으면 좌우 분할 자체가 성립하지
// 않으므로(디바이더가 보이는데 끌어도 움직이지 않는 구간이 생긴다) CSS가 세로 스택으로 넘긴다.
export const WORKSPACE_DOCK_SPLIT_MIN_WIDTH = WORKSPACE_DOCK_FILES_MIN_WIDTH + WORKSPACE_DOCK_DIVIDER_WIDTH + WORKSPACE_DOCK_MAIN_MIN_WIDTH;

export const PREFS_WORKSPACE_DOCK_HEIGHT = "fleet-console.repository.workspace.dockHeight";
export const PREFS_WORKSPACE_DOCK_FILES_WIDTH = "fleet-console.repository.workspace.dockFilesWidth";

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

export function readWorkspaceDockFilesWidth(storage?: StorageLike): number {
  try {
    const value = Number.parseFloat((storage ?? globalThis.localStorage).getItem(PREFS_WORKSPACE_DOCK_FILES_WIDTH) ?? "");
    if (Number.isFinite(value) && value >= WORKSPACE_DOCK_FILES_MIN_WIDTH) return value;
  } catch { /* best-effort preference */ }
  return WORKSPACE_DOCK_FILES_DEFAULT_WIDTH;
}

export function saveWorkspaceDockFilesWidth(width: number, storage?: StorageLike): void {
  try { (storage ?? globalThis.localStorage).setItem(PREFS_WORKSPACE_DOCK_FILES_WIDTH, String(width)); }
  catch { /* best-effort preference */ }
}

export function clampWorkspaceDockFilesWidth(startWidth: number, pointerDeltaX: number, containerWidth: number): number | null {
  const maximum = containerWidth - WORKSPACE_DOCK_MAIN_MIN_WIDTH - WORKSPACE_DOCK_DIVIDER_WIDTH;
  if (maximum < WORKSPACE_DOCK_FILES_MIN_WIDTH) return null;
  return Math.max(WORKSPACE_DOCK_FILES_MIN_WIDTH, Math.min(maximum, startWidth + pointerDeltaX));
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
