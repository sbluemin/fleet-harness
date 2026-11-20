import { useSyncExternalStore } from "react";

/**
 * 독립 CLI(Claude Code · Antigravity) 패널과 선택 팔레트의 화면 상태. Console 하나에 CLI 종류별 1슬롯이다.
 *
 * 패널을 닫는 것은 숨기는 것이다 — 표면(터미널)은 마운트된 채 남아 PTY와 화면·스크롤·입력 줄을 그대로 쥐고,
 * 다시 열면 같은 화면이 선다. PTY가 끝났을 때(`/exit` 또는 팔레트 종료)만 그 CLI의 표면을 걷고,
 * 다음 열기가 그때 보는 Theater에서 새로 띄운다.
 */
export const STANDALONE_CLI_KINDS = ["claude", "antigravity"] as const;
export type StandaloneCliKind = (typeof STANDALONE_CLI_KINDS)[number];

export interface StandaloneCliPlacement {
  readonly commodoreId: string;
  readonly theaterId: string;
}

export interface StandaloneCliSlotViewState {
  /** 표면이 붙어 있는 CLI의 자리. null이면 붙은 CLI가 없다. */
  readonly placement: StandaloneCliPlacement | null;
  /** 서버가 보고한 설치 여부. 아직 조회 전이면 true로 두어 클릭을 막지 않는다. */
  readonly installed: boolean;
  /** 서버에서 살아 있는 PTY가 있거나 클라이언트에 마운트되어 실패하지 않은 상태. */
  readonly live: boolean;
  /** 서버가 쥔 자리(새로고침 뒤에도 살아 있는 CLI에 다시 붙기 위한 스냅샷). */
  readonly serverPlacement: StandaloneCliPlacement | null;
  /** 새 CLI를 붙일 때마다 오른다 — 끝난 CLI의 표면을 새 표면으로 갈아 끼우는 key다. */
  readonly generation: number;
  /** 이 세대의 CLI를 띄우지 못했다. 열린 동안 실패 화면을 보이고, 다음 선택 시 새 세대로 다시 띄운다. */
  readonly failed: boolean;
}

export interface StandaloneCliViewState {
  /** 현재 화면에 서 있는 CLI. null이면 숨김 상태다. */
  readonly activeCli: StandaloneCliKind | null;
  /** 가장 최근에 열었던 CLI — 팔레트 기본 포커스 자리. */
  readonly lastCli: StandaloneCliKind | null;
  /** CLI 선택 팔레트가 열려 있는가. */
  readonly paletteOpen: boolean;
  /** 팔레트를 열 시점에 보고 있던 사령관·작전 구역. */
  readonly viewed: { readonly commodoreId: string | null; readonly theaterId: string | null };
  /** 붙은 CLI도 없고 고를 Theater도 없어 안내를 보이는 중인가. */
  readonly needsTheater: boolean;
  /** 열 때마다 하나씩 오른다 — 터미널이 키보드 포커스를 다시 잡는 신호다. */
  readonly focusRequest: number;
  readonly slots: Readonly<Record<StandaloneCliKind, StandaloneCliSlotViewState>>;
}

const STATE_PATH = "/api/v1/standalone-cli/state";
const STOP_PATH = "/api/v1/standalone-cli/stop";

function emptySlot(): StandaloneCliSlotViewState {
  return { placement: null, installed: true, live: false, serverPlacement: null, generation: 0, failed: false };
}

let state: StandaloneCliViewState = {
  activeCli: null,
  lastCli: null,
  paletteOpen: false,
  viewed: { commodoreId: null, theaterId: null },
  needsTheater: false,
  focusRequest: 0,
  slots: {
    claude: emptySlot(),
    antigravity: emptySlot(),
  },
};

const listeners = new Set<() => void>();
let refreshSeq = 0;

/**
 * 열기 직전에 포커스가 있던 곳(보던 대화의 입력창 등). 닫으면 그리로 돌려준다.
 */
let returnFocus: HTMLElement | null = null;

function rememberReturnFocus(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  returnFocus = active instanceof HTMLElement
    && active !== document.body
    && active.closest(".standalone-cli-layer") === null
    && active.closest(".standalone-cli-palette-overlay") === null
    ? active
    : null;
}

/** 닫힌 패널·팔레트가 포커스를 돌려줄 곳을 한 번 꺼낸다. */
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

interface ServerSlotPayload {
  readonly live?: unknown;
  readonly installed?: unknown;
  readonly commodoreId?: unknown;
  readonly theaterId?: unknown;
}

function parseServerSlot(raw: unknown): { readonly live: boolean; readonly installed: boolean; readonly placement: StandaloneCliPlacement | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const slot = raw as ServerSlotPayload;
  const placement = typeof slot.commodoreId === "string" && typeof slot.theaterId === "string"
    ? { commodoreId: slot.commodoreId, theaterId: slot.theaterId }
    : null;
  return {
    live: slot.live === true,
    installed: slot.installed !== false,
    placement,
  };
}

async function fetchServerSlots(): Promise<Readonly<Record<StandaloneCliKind, { readonly live: boolean; readonly installed: boolean; readonly placement: StandaloneCliPlacement | null }>> | null> {
  try {
    const response = await fetch(STATE_PATH);
    if (!response.ok) return null;
    const payload = await response.json() as { readonly slots?: Readonly<Record<string, unknown>> };
    if (!payload.slots || typeof payload.slots !== "object") return null;
    const claude = parseServerSlot(payload.slots.claude);
    const antigravity = parseServerSlot(payload.slots.antigravity);
    if (!claude || !antigravity) return null;
    return { claude, antigravity };
  } catch {
    return null;
  }
}

async function refreshServerState(): Promise<void> {
  const seq = ++refreshSeq;
  const remote = await fetchServerSlots();
  if (!remote || seq !== refreshSeq) return;
  const mergeSlot = (cli: StandaloneCliKind): StandaloneCliSlotViewState => {
    const prev = state.slots[cli];
    const next = remote[cli];
    const mountedLive = prev.placement !== null && !prev.failed;
    return {
      ...prev,
      installed: next.installed,
      live: next.live || mountedLive,
      serverPlacement: next.placement,
    };
  };
  write({
    ...state,
    slots: {
      claude: mergeSlot("claude"),
      antigravity: mergeSlot("antigravity"),
    },
  });
}

/**
 * Ctrl+`.
 * - 팔레트가 열려 있으면 닫는다.
 * - 터미널이 열려 있으면 1키로 즉시 숨긴다(PTY·스크롤백 유지).
 * - 둘 다 닫혀 있으면 미니멀 CLI 선택 팔레트를 연다.
 */
export async function toggleStandaloneCli(viewed: { readonly commodoreId: string | null; readonly theaterId: string | null }): Promise<void> {
  if (state.paletteOpen) {
    closeStandaloneCliPalette();
    return;
  }
  if (state.activeCli !== null || state.needsTheater) {
    write({ ...state, activeCli: null, needsTheater: false });
    return;
  }
  rememberReturnFocus();
  write({ ...state, paletteOpen: true, viewed, needsTheater: false });
  await refreshServerState();
}

/**
 * Ctrl+Shift+`. 터미널이 열려 있는 상태에서도 바로 CLI 선택 팔레트를 여닫는다.
 */
export async function switchStandaloneCli(viewed: { readonly commodoreId: string | null; readonly theaterId: string | null }): Promise<void> {
  if (state.paletteOpen) {
    closeStandaloneCliPalette();
    return;
  }
  if (state.activeCli === null) rememberReturnFocus();
  write({ ...state, paletteOpen: true, viewed, needsTheater: false });
  await refreshServerState();
}

export function closeStandaloneCliPalette(): void {
  if (!state.paletteOpen) return;
  write({
    ...state,
    paletteOpen: false,
    ...(state.activeCli !== null ? { focusRequest: state.focusRequest + 1 } : {}),
  });
}

/**
 * 팔레트에서 CLI를 고른다. 살아 있는 세션이 있으면 그대로 복귀하고, 없으면 현재 작전 구역(또는 폴백 선택)에서 새로 띄운다.
 */
export async function selectStandaloneCli(
  cli: StandaloneCliKind,
  fallbackPlacement?: StandaloneCliPlacement | null,
): Promise<void> {
  const slot = state.slots[cli];
  if (!slot.installed) return;

  // 이미 마운트되어 살아 있는 CLI는 숨겼던 그대로 다시 보인다.
  if (slot.placement !== null && !slot.failed) {
    write({
      ...state,
      activeCli: cli,
      lastCli: cli,
      paletteOpen: false,
      needsTheater: false,
      focusRequest: state.focusRequest + 1,
    });
    return;
  }

  const viewedPlacement = state.viewed.commodoreId !== null && state.viewed.theaterId !== null
    ? { commodoreId: state.viewed.commodoreId, theaterId: state.viewed.theaterId }
    : null;
  const placement = (slot.live ? slot.serverPlacement : null)
    ?? viewedPlacement
    ?? fallbackPlacement
    ?? slot.serverPlacement
    ?? (slot.failed ? slot.placement : null);

  if (placement === null) {
    write({
      ...state,
      activeCli: null,
      paletteOpen: false,
      needsTheater: true,
    });
    return;
  }

  write({
    ...state,
    activeCli: cli,
    lastCli: cli,
    paletteOpen: false,
    needsTheater: false,
    focusRequest: state.focusRequest + 1,
    slots: {
      ...state.slots,
      [cli]: {
        ...slot,
        placement,
        live: true,
        failed: false,
        generation: slot.generation + 1,
      },
    },
  });
}

/** 팔레트에서 살아 있는 CLI 세션을 종료한다. */
export async function stopStandaloneCli(cli: StandaloneCliKind): Promise<void> {
  try {
    await fetch(STOP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cli }),
    });
  } catch {
    // 네트워크 오류가 나더라도 화면 슬롯을 정리해 멈추지 않게 한다.
  }
  const slot = state.slots[cli];
  const nextActive = state.activeCli === cli ? null : state.activeCli;
  const nextLast = state.lastCli === cli
    ? (STANDALONE_CLI_KINDS.find((kind) => kind !== cli && state.slots[kind].live) ?? null)
    : state.lastCli;
  write({
    ...state,
    activeCli: nextActive,
    lastCli: nextLast,
    slots: {
      ...state.slots,
      [cli]: {
        ...slot,
        placement: null,
        serverPlacement: null,
        live: false,
        failed: false,
      },
    },
  });
}

/** 이 세대의 CLI를 띄우지 못했다. 실패 화면은 그대로 두고, 다음 선택이 새 세대로 다시 띄우게 표시만 한다. */
export function failStandaloneCli(cli: StandaloneCliKind, generation: number): void {
  const slot = state.slots[cli];
  if (slot.generation !== generation || slot.placement === null || slot.failed) return;
  write({
    ...state,
    slots: {
      ...state.slots,
      [cli]: { ...slot, live: false, failed: true },
    },
  });
}

/** PTY가 끝났다. 표면을 걷고 해당 CLI가 열려 있었다면 닫는다. */
export function endStandaloneCli(cli: StandaloneCliKind, generation: number): void {
  const slot = state.slots[cli];
  if (slot.generation !== generation || slot.placement === null) return;
  const nextActive = state.activeCli === cli ? null : state.activeCli;
  const nextLast = state.lastCli === cli
    ? (STANDALONE_CLI_KINDS.find((kind) => kind !== cli && state.slots[kind].live) ?? null)
    : state.lastCli;
  write({
    ...state,
    activeCli: nextActive,
    lastCli: nextLast,
    needsTheater: false,
    slots: {
      ...state.slots,
      [cli]: {
        ...slot,
        placement: null,
        serverPlacement: null,
        live: false,
        failed: false,
      },
    },
  });
}
