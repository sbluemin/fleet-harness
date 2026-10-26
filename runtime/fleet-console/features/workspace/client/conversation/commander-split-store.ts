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
  if (state.open && picked === state.picked) return;
  setState({ ...state, open: true, picked });
}

/** 분할을 닫는다 — 모든 사령관에서 닫힌 채 남는다. 고른 지휘관은 기억에 남겨 다시 열 때 그대로 선다. */
export function closeCommanderSplit(): void {
  if (!state.open) return;
  writeStorage(OPEN_KEY, null);
  setState({ ...state, open: false });
}

export function setCommanderSplitRatio(ratio: number): void {
  const next = clampCommanderSplitRatio(ratio);
  if (next === state.ratio) return;
  writeStorage(RATIO_KEY, String(next));
  setState({ ...state, ratio: next });
}
