import type { Translate } from "@fleet-console/sdk/i18n";

import type { RepositoryMessageKey } from "./i18n/index.js";

export const WORKSPACE_DOCK_DEFAULT_HEIGHT = 230;
export const WORKSPACE_DOCK_MIN_HEIGHT = 160;
/** 접힌 독 — 머리줄 한 줄. 보던 커밋의 정체성만 남긴다. */
export const WORKSPACE_DOCK_COLLAPSED_HEIGHT = 32;
/** 전체 정착점에서 목록에 남기는 높이 — 툴바 + 그래프 3행. 선택 행 주변 문맥이 사라지지 않게. */
export const WORKSPACE_LIST_KEEP_HEIGHT = 128;
/** 정착점 자석 반경 — 이 안에서 손을 놓으면 정착점으로 안착한다. */
export const WORKSPACE_DOCK_SNAP_RADIUS = 24;
/** 최소보다 이만큼 더 끌어내리면 "접겠다"는 뜻으로 읽는다. */
export const WORKSPACE_DOCK_COLLAPSE_PULL = 40;
export const WORKSPACE_TREE_DEFAULT_WIDTH = 222;
const WORKSPACE_TREE_MIN_WIDTH = 148;
/** 모든 분할 이음매의 트랙 폭. 선은 1px이고 잡는 영역은 CSS가 양쪽으로 넓힌다. */
export const WORKSPACE_SEAM_WIDTH = 1;
const WORKSPACE_TREE_DIVIDER_WIDTH = WORKSPACE_SEAM_WIDTH;
// 트리를 줄여도 중앙(History/Changes) 영역이 유의미하게 남도록 하는 최소 보장 폭.
const WORKSPACE_MAIN_MIN_WIDTH = 180;

// 검사기 독(파일 목록 ⇔ diff)의 폭 축. 저장값은 CSS 변수로만 주입한다 — 인라인
// grid-template-columns는 좁은 독을 세로 스택으로 바꾸는 컨테이너 쿼리를 이겨버려
// main 열 0 붕괴(PR#516에서 고친 선존 결함)를 되살린다.
export const WORKSPACE_DOCK_FILES_DEFAULT_WIDTH = 250;
export const WORKSPACE_DOCK_FILES_MIN_WIDTH = 150;
export const WORKSPACE_DOCK_DIVIDER_WIDTH = WORKSPACE_SEAM_WIDTH;
// diff 열의 최소 폭. CSS의 calc(100% - …) 보정값과 반드시 같은 값이어야 한다.
export const WORKSPACE_DOCK_MAIN_MIN_WIDTH = 340;
// 두 최소폭과 디바이더가 모두 들어가는 최소 독 폭. 이보다 좁으면 좌우 분할 자체가 성립하지
// 않으므로(디바이더가 보이는데 끌어도 움직이지 않는 구간이 생긴다) CSS가 세로 스택으로 넘긴다.
export const WORKSPACE_DOCK_SPLIT_MIN_WIDTH = WORKSPACE_DOCK_FILES_MIN_WIDTH + WORKSPACE_DOCK_DIVIDER_WIDTH + WORKSPACE_DOCK_MAIN_MIN_WIDTH;

export type WorkspaceDockTab = "details" | "changes" | "tree";
export type WorkspaceDockDetent = "half" | "full" | "free";

export const PREFS_WORKSPACE_DOCK_HEIGHT = "fleet-console.repository.workspace.dockHeight";
export const PREFS_WORKSPACE_TREE_WIDTH = "fleet-console.repository.workspace.treeWidth";
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

/**
 * 독 높이는 탭마다 기억한다 — 세부 정보(짧은 메타)와 변경(diff)은 필요한 높이가 다르다.
 * 옛 단일 키(dockHeight)는 모든 탭의 초기값으로 읽어 이관한다.
 */
export function readWorkspaceDockHeight(tab?: WorkspaceDockTab, storage?: StorageLike): number {
  const store = storage ?? globalThis.localStorage;
  const read = (key: string): number | null => {
    try {
      const value = Number.parseFloat(store.getItem(key) ?? "");
      return Number.isFinite(value) && value >= WORKSPACE_DOCK_MIN_HEIGHT ? value : null;
    } catch { return null; }
  };
  return (tab ? read(`${PREFS_WORKSPACE_DOCK_HEIGHT}.${tab}`) : null) ?? read(PREFS_WORKSPACE_DOCK_HEIGHT) ?? WORKSPACE_DOCK_DEFAULT_HEIGHT;
}

export function saveWorkspaceDockHeight(height: number, tab?: WorkspaceDockTab, storage?: StorageLike): void {
  try {
    const store = storage ?? globalThis.localStorage;
    store.setItem(PREFS_WORKSPACE_DOCK_HEIGHT, String(height));
    if (tab) store.setItem(`${PREFS_WORKSPACE_DOCK_HEIGHT}.${tab}`, String(height));
  } catch { /* best-effort preference */ }
}

export interface WorkspaceDockDetents {
  readonly half: number;
  readonly full: number;
}

/** 독이 차지할 수 있는 최대 높이 — 목록에 툴바+3행을 남긴 나머지. 최소보다 작을 수 있고, 그때는 정규화가 독을 줄인다. */
export function workspaceDockMaxHeight(containerHeight: number): number {
  return Math.round(containerHeight - WORKSPACE_LIST_KEEP_HEIGHT - WORKSPACE_SEAM_WIDTH);
}

/** 독의 정착점 — 절반은 작업면의 40%(최소 240), 전체는 최대 높이. 짧은 컨테이너에서도 정착점은 최소 아래로 내려가지 않는다. */
export function workspaceDockDetents(containerHeight: number): WorkspaceDockDetents {
  const full = Math.max(WORKSPACE_DOCK_MIN_HEIGHT, workspaceDockMaxHeight(containerHeight));
  const half = Math.min(full, Math.max(240, Math.round(containerHeight * 0.4)));
  return { half, full };
}

/** 저장·정규화된 높이가 어느 정착점에 앉아 있는지 — 재마운트 뒤에도 머리줄 토글과 창 추종이 정착점을 잃지 않게. */
export function detentForWorkspaceDockHeight(height: number, containerHeight: number): WorkspaceDockDetent {
  const { half, full } = workspaceDockDetents(containerHeight);
  if (height === full) return "full";
  if (height === half) return "half";
  return "free";
}

export function normalizeWorkspaceDockHeight(storedHeight: number, containerHeight: number): number {
  const maximum = workspaceDockMaxHeight(containerHeight);
  if (maximum <= WORKSPACE_DOCK_MIN_HEIGHT) return Math.max(0, maximum);
  return Math.max(WORKSPACE_DOCK_MIN_HEIGHT, Math.min(maximum, storedHeight));
}

export interface WorkspaceDockDragResult {
  /** 화면에 그릴 높이. 한계 밖에서는 최대 4px의 고무줄 저항만 허용한다. */
  readonly height: number;
  /** 손을 놓았을 때 도착할 정착점 — 자석 반경 안이면 해당 정착점, 아니면 free. */
  readonly detent: WorkspaceDockDetent | "collapse";
  /** 한계에 닿아 있는지 — 읽기 값이 이유를 말한다. */
  readonly limit: "min" | "max" | null;
}

export function dragWorkspaceDockHeight(startHeight: number, pointerDeltaY: number, containerHeight: number): WorkspaceDockDragResult | null {
  if (workspaceDockMaxHeight(containerHeight) < WORKSPACE_DOCK_MIN_HEIGHT) return null;
  const { half, full } = workspaceDockDetents(containerHeight);
  const raw = startHeight - pointerDeltaY;
  if (raw < WORKSPACE_DOCK_MIN_HEIGHT - WORKSPACE_DOCK_COLLAPSE_PULL) return { height: WORKSPACE_DOCK_MIN_HEIGHT - 4, detent: "collapse", limit: "min" };
  if (raw < WORKSPACE_DOCK_MIN_HEIGHT) return { height: WORKSPACE_DOCK_MIN_HEIGHT - Math.min(4, (WORKSPACE_DOCK_MIN_HEIGHT - raw) * 0.15), detent: "free", limit: "min" };
  if (raw > full) return { height: full + Math.min(4, (raw - full) * 0.15), detent: "full", limit: "max" };
  if (Math.abs(raw - full) <= WORKSPACE_DOCK_SNAP_RADIUS) return { height: raw, detent: "full", limit: null };
  if (Math.abs(raw - half) <= WORKSPACE_DOCK_SNAP_RADIUS) return { height: raw, detent: "half", limit: null };
  return { height: raw, detent: "free", limit: null };
}

/** 손을 놓은 뒤의 최종 높이 — 정착점이면 그 값, 아니면 한계 안으로 자른 자유 높이. */
export function settleWorkspaceDockHeight(result: WorkspaceDockDragResult, containerHeight: number): number {
  const { half, full } = workspaceDockDetents(containerHeight);
  if (result.detent === "full") return full;
  if (result.detent === "half") return half;
  return Math.max(WORKSPACE_DOCK_MIN_HEIGHT, Math.min(full, result.height));
}

export function buildWorkspaceDockTemplate(dockHeight: number): string {
  return `minmax(${WORKSPACE_LIST_KEEP_HEIGHT}px, 1fr) ${WORKSPACE_SEAM_WIDTH}px ${dockHeight}px`;
}

export function buildWorkspaceDockCollapsedTemplate(): string {
  return `minmax(0, 1fr) ${WORKSPACE_DOCK_COLLAPSED_HEIGHT}px`;
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
