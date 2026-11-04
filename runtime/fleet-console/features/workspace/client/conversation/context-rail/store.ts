import { useSyncExternalStore } from "react";

/**
 * 컨텍스트 레일의 사람 몫 상태. 켜짐/꺼짐과 카드별 접힘은 브라우저에 기억하고(켜짐이 기본), 펼친 MCP 서버·떠 있는 칩 카드는
 * 이 페이지의 일시 상태다. 레일을 꺼도 원호 같은 다른 컨텍스트 표시는 돌아오지 않는다.
 */
const OFF_KEY = "fleet-console.contextRail.off";
const CARDS_KEY = "fleet-console.contextRail.cards";

interface RailMemory {
  /** 보는 세션 카드를 사람이 접었다. */
  readonly collapsedFocus: readonly string[];
  /** 보는 세션이 아닌 카드를 사람이 펼쳤다. */
  readonly expandedOthers: readonly string[];
}

function readEnabled(): boolean {
  try { return window.localStorage.getItem(OFF_KEY) !== "1"; } catch { return true; }
}

function readMemory(): RailMemory {
  try {
    const raw = window.localStorage.getItem(CARDS_KEY);
    if (raw === null) return { collapsedFocus: [], expandedOthers: [] };
    const value = JSON.parse(raw) as Partial<RailMemory>;
    const list = (input: unknown): string[] => Array.isArray(input) ? input.filter((id): id is string => typeof id === "string").slice(0, 200) : [];
    return { collapsedFocus: list(value.collapsedFocus), expandedOthers: list(value.expandedOthers) };
  } catch {
    return { collapsedFocus: [], expandedOthers: [] };
  }
}

export interface ContextRailState {
  readonly enabled: boolean;
  readonly memory: RailMemory;
  /** 오버레이에서 상세 카드가 떠 있는 세션 id. */
  readonly flyout: string | null;
  /** 펼친 상세(메모리 파일·MCP 도구·서버) 키. */
  readonly details: ReadonlySet<string>;
  /** `/context`가 카드를 펼쳐 달라고 한 마지막 요청. 값이 바뀌었다는 사실이 신호다. */
  readonly reveal: { readonly id: string; readonly nonce: number } | null;
}

let state: ContextRailState = { enabled: readEnabled(), memory: readMemory(), flyout: null, details: new Set(), reveal: null };
const listeners = new Set<() => void>();

function publish(next: ContextRailState): void {
  state = next;
  for (const listener of listeners) listener();
}

function remember(memory: RailMemory): void {
  try { window.localStorage.setItem(CARDS_KEY, JSON.stringify(memory)); } catch { /* 기억하지 못하면 기본대로 선다 */ }
}

export function useContextRailState(): ContextRailState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
    () => state,
  );
}

export function setContextRailEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(OFF_KEY);
    else window.localStorage.setItem(OFF_KEY, "1");
  } catch { /* 기억하지 못하면 이 페이지에서만 유지된다 */ }
  publish({ ...state, enabled, flyout: null });
}

/** 보는 세션이면 접힘을, 아니면 펼침을 뒤집는다. 접힘/펼침은 카드별로 기억한다. */
export function toggleContextCard(id: string, focus: boolean): void {
  const { memory } = state;
  const has = (list: readonly string[]) => list.includes(id);
  const flip = (list: readonly string[]) => has(list) ? list.filter((item) => item !== id) : [...list, id];
  const next: RailMemory = focus ? { ...memory, collapsedFocus: flip(memory.collapsedFocus) } : { ...memory, expandedOthers: flip(memory.expandedOthers) };
  remember(next);
  publish({ ...state, memory: next });
}

export function setContextFlyout(id: string | null): void {
  if (state.flyout === id) return;
  publish({ ...state, flyout: id });
}

export function toggleContextDetail(key: string): void {
  const details = new Set(state.details);
  if (!details.delete(key)) details.add(key);
  publish({ ...state, details });
}

/**
 * 한 세션의 카드를 펼쳐 보인다(`/context`). 레일이 꺼져 있으면 켠다. 오버레이는 그 세션의 상세 카드를 띄운다.
 */
export function revealContextCard(id: string): void {
  try { window.localStorage.removeItem(OFF_KEY); } catch { /* 위와 같다 */ }
  const memory: RailMemory = {
    collapsedFocus: state.memory.collapsedFocus.filter((item) => item !== id),
    expandedOthers: state.memory.expandedOthers.includes(id) ? state.memory.expandedOthers : [...state.memory.expandedOthers, id],
  };
  remember(memory);
  publish({ ...state, enabled: true, memory, reveal: { id, nonce: (state.reveal?.nonce ?? 0) + 1 } });
}
