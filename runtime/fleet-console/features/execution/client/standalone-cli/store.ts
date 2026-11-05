import { useSyncExternalStore } from "react";

/**
 * 독립 Claude Code CLI 패널의 화면 상태. Console 하나에 CLI 하나다.
 *
 * 패널을 닫는 것은 숨기는 것이다 — 표면(터미널)은 마운트된 채 남아 PTY와 화면·스크롤·입력 줄을 그대로 쥐고,
 * 다시 열면 같은 화면이 선다. PTY가 끝났을 때(`/exit`)만 표면을 걷고, 다음 열기가 그때 보는 Theater에서 새로 띄운다.
 * 처음 띄운 Theater가 이 CLI의 자리다: 그 뒤 다른 Theater로 옮겨도 살아 있는 CLI는 따라가지 않는다.
 */
export interface StandaloneCliPlacement {
  readonly commodoreId: string;
  readonly theaterId: string;
}

export interface StandaloneCliViewState {
  /** 패널이 화면에 서 있는가. */
  readonly open: boolean;
  /** 표면이 붙어 있는 CLI의 자리. null이면 붙은 CLI가 없다. */
  readonly placement: StandaloneCliPlacement | null;
  /** 붙은 CLI가 없고 고를 Theater도 없어 안내를 보이는 중인가. */
  readonly needsTheater: boolean;
  /** 열 때마다 하나씩 오른다 — 터미널이 키보드 포커스를 다시 잡는 신호다. */
  readonly focusRequest: number;
  /** 새 CLI를 붙일 때마다 오른다 — 끝난 CLI의 표면을 새 표면으로 갈아 끼우는 key다. */
  readonly generation: number;
}

const STATE_PATH = "/api/v1/standalone-cli/state";

let state: StandaloneCliViewState = { open: false, placement: null, needsTheater: false, focusRequest: 0, generation: 0 };
const listeners = new Set<() => void>();
let toggling = false;
/**
 * 열기 직전에 포커스가 있던 곳(보던 대화의 입력창 등). 닫으면 그리로 돌려준다. 열린 동안 밑의 칸은 가려져 포커스를
 * 잃으므로, 화면이 바뀌기 전인 여기서 붙잡아야 한다.
 */
let returnFocus: HTMLElement | null = null;

function rememberReturnFocus(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  returnFocus = active instanceof HTMLElement && active !== document.body && active.closest(".standalone-cli-layer") === null ? active : null;
}

/** 닫힌 패널이 포커스를 돌려줄 곳을 한 번 꺼낸다. */
export function takeStandaloneCliReturnFocus(): HTMLElement | null {
  const target = returnFocus;
  returnFocus = null;
  return target;
}

function write(next: StandaloneCliViewState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getStandaloneCliState(): StandaloneCliViewState {
  return state;
}

export function subscribeStandaloneCli(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useStandaloneCliState(): StandaloneCliViewState {
  return useSyncExternalStore(subscribeStandaloneCli, getStandaloneCliState, getStandaloneCliState);
}

/** 서버가 쥔 자리. 새로고침 뒤에도 살아 있는 CLI에 다시 붙기 위해 연다 — 브라우저는 그 Theater의 불투명 id만 받는다. */
async function readServerPlacement(): Promise<StandaloneCliPlacement | null> {
  try {
    const response = await fetch(STATE_PATH);
    if (!response.ok) return null;
    const payload = await response.json() as { readonly commodoreId?: unknown; readonly theaterId?: unknown };
    return typeof payload.commodoreId === "string" && typeof payload.theaterId === "string"
      ? { commodoreId: payload.commodoreId, theaterId: payload.theaterId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Ctrl+₩. 열려 있으면 숨기고, 닫혀 있으면 연다. 열 때 붙은 CLI가 있으면 그것을, 없으면 서버가 쥔 CLI를,
 * 그것도 없으면 지금 보는 Theater에서 새 CLI를 띄운다. 셋 다 없으면 Theater 선택 안내를 보인다.
 */
export async function toggleStandaloneCli(viewed: { readonly commodoreId: string | null; readonly theaterId: string | null }): Promise<void> {
  if (toggling) return;
  if (state.open) {
    write({ ...state, open: false, needsTheater: false });
    return;
  }
  rememberReturnFocus();
  if (state.placement !== null) {
    write({ ...state, open: true, needsTheater: false, focusRequest: state.focusRequest + 1 });
    return;
  }
  toggling = true;
  try {
    const placement = await readServerPlacement()
      ?? (viewed.commodoreId !== null && viewed.theaterId !== null ? { commodoreId: viewed.commodoreId, theaterId: viewed.theaterId } : null);
    write(placement === null
      ? { ...state, open: true, needsTheater: true }
      : { open: true, placement, needsTheater: false, focusRequest: state.focusRequest + 1, generation: state.generation + 1 });
  } finally {
    toggling = false;
  }
}

/** 열린 패널의 터미널이 키보드 포커스를 다시 잡게 한다(pill 누름). */
export function focusStandaloneCli(): void {
  if (!state.open || state.placement === null) return;
  write({ ...state, focusRequest: state.focusRequest + 1 });
}

export function closeStandaloneCli(): void {
  if (!state.open) return;
  write({ ...state, open: false, needsTheater: false });
}

/** PTY가 끝났다. 표면을 걷고 패널을 닫는다 — 같은 자리에 끝난 화면을 남기지 않는다. */
export function endStandaloneCli(generation: number): void {
  if (state.generation !== generation || state.placement === null) return;
  write({ ...state, open: false, placement: null, needsTheater: false });
}
