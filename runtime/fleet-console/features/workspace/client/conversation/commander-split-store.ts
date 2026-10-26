import { useSyncExternalStore } from "react";

/*
 * 사령관 대화의 지휘관 분할 — 사령관 대화 옆에 그 사령관의 지휘관 그룹 대화를 세운다. 브라우저 선호라 브라우저에만 남는다.
 * 열림과 나눈 비율은 하나만 저장해 모든 사령관이 함께 쓴다(오른쪽 사이드바 닫힘 기억과 같은 전역 규칙). 어느 지휘관을 세웠는지는
 * 사령관마다 기억한다 — 지휘관은 그 사령관의 것이다.
 */

const OPEN_KEY = "fleet-console.commanderSplit.open";
const RATIO_KEY = "fleet-console.commanderSplit.ratio";
const PICKED_KEY = "fleet-console.commanderSplit.picked";

/** 사령관 대화 칸이 차지하는 비율의 범위 — 두 칸 모두 읽을 만한 폭을 남긴다. */
export const COMMANDER_SPLIT_MIN_RATIO = 0.3;
export const COMMANDER_SPLIT_MAX_RATIO = 0.7;
const DEFAULT_RATIO = 0.5;

export interface CommanderSplitState {
  readonly open: boolean;
  /** 사령관 대화 칸의 폭 비율(0.3–0.7). */
  readonly ratio: number;
  /** 사령관 UUID → 그 사령관에서 마지막으로 세운 지휘관 Objective id. */
  readonly picked: Readonly<Record<string, string>>;
  /**
   * 두 칸이 들어가지 않는 좁은 창에서 보이는 한 칸 — 지휘관을 고르면 지휘관 칸, 「← 사령관」을 누르면 사령관 칸이다. 저장하지 않는
   * 화면 상태라 창을 넓히면 다시 두 칸이 선다.
   */
  readonly narrowPane: "commander" | "commodore";
  /** 옆 칸에서 크게 보기로 넘어온 대화만 돌아가기 단추를 가진다. 저장하지 않는다. */
  readonly expanded: { readonly commodoreId: string; readonly objectiveId: string } | null;
}

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
}

export function clampCommanderSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  return Math.min(COMMANDER_SPLIT_MAX_RATIO, Math.max(COMMANDER_SPLIT_MIN_RATIO, ratio));
}

function readPicked(): Record<string, string> {
  const raw = readStorage(PICKED_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [commodoreId, objectiveId] of Object.entries(parsed)) {
      if (typeof objectiveId === "string" && objectiveId !== "") out[commodoreId] = objectiveId;
    }
    return out;
  } catch {
    return {};
  }
}

function readInitial(): CommanderSplitState {
  const ratio = Number(readStorage(RATIO_KEY));
  return {
    open: readStorage(OPEN_KEY) === "1",
    ratio: readStorage(RATIO_KEY) === null ? DEFAULT_RATIO : clampCommanderSplitRatio(ratio),
    picked: readPicked(),
    narrowPane: "commander",
    expanded: null,
  };
}

let state: CommanderSplitState = readInitial();
const listeners = new Set<() => void>();

function setState(next: CommanderSplitState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCommanderSplit(): CommanderSplitState {
  return state;
}

export function useCommanderSplit(): CommanderSplitState {
  return useSyncExternalStore(subscribe, getCommanderSplit, getCommanderSplit);
}

/** 지휘관을 사령관 대화 옆에 세운다 — 분할이 닫혀 있으면 연다. */
export function openCommanderSplit(commodoreId: string, objectiveId: string): void {
  const picked = state.picked[commodoreId] === objectiveId ? state.picked : { ...state.picked, [commodoreId]: objectiveId };
  if (picked !== state.picked) writeStorage(PICKED_KEY, JSON.stringify(picked));
  if (!state.open) writeStorage(OPEN_KEY, "1");
  if (state.open && picked === state.picked && state.narrowPane === "commander" && state.expanded === null) return;
  setState({ ...state, open: true, picked, narrowPane: "commander", expanded: null });
}

/** 좁은 창에서 지휘관 칸 대신 사령관 칸을 보인다 — 분할의 열림 기억은 그대로다. */
export function showCommodoreInNarrowSplit(): void {
  if (state.narrowPane === "commodore") return;
  setState({ ...state, narrowPane: "commodore" });
}

/** 분할을 닫는다 — 모든 사령관에서 닫힌 채 남는다. 고른 지휘관은 기억에 남겨 다시 열 때 그대로 선다. */
export function closeCommanderSplit(): void {
  if (!state.open) return;
  writeStorage(OPEN_KEY, null);
  setState({ ...state, open: false });
}

/**
 * 지금 사령관 대화 옆 칸에 보이는 지휘관 — 가운데 칸의 주인(활성 Objective)과 따로, 사람이 읽고 있는 지휘관이다. 도착 표식의
 * 확인과 활동 전이 추적이 활성 Objective 처럼 이 지휘관도 「보고 있음」으로 읽는다. 화면 상태라 저장하지 않는다.
 */
let visibleObjectiveId: string | null = null;

export function setCommanderSplitVisibleObjective(objectiveId: string | null): void {
  visibleObjectiveId = objectiveId;
}

export function getCommanderSplitVisibleObjective(): string | null {
  return visibleObjectiveId;
}

export function setCommanderSplitRatio(ratio: number): void {
  const next = clampCommanderSplitRatio(ratio);
  if (next === state.ratio) return;
  writeStorage(RATIO_KEY, String(next));
  setState({ ...state, ratio: next });
}

/** 새 세션은 아직 Objective id가 없으므로 마지막 선택을 덮지 않고 옆 칸만 연다. */
export function revealCommanderSplit(): void {
  writeStorage(OPEN_KEY, "1");
  setState({ ...state, open: true, narrowPane: "commander", expanded: null });
}

export function setExpandedCommanderSplit(expanded: CommanderSplitState["expanded"]): void {
  if (state.expanded === expanded) return;
  setState({ ...state, expanded });
}
