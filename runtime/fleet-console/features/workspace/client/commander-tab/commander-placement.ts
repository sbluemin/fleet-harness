import { useSyncExternalStore } from "react";

import {
  getGlobalSettingsStoreState,
  setGlobalSettingsField,
  subscribe as subscribeGlobalSettings,
} from "../../../settings/client/global-settings-store.js";

/** 지휘관 목록이 서는 사이드바. 왼쪽이 기본이다. */
export type CommanderPlacement = "left" | "right";

const KEY = "fleet-console.commanderList.place";
const LEGACY_SIDE_KEY = "fleet-console.commanderRail.side";
const RAIL_EXPANDED_KEY = "fleet-console.commanderList.expanded";
// 거둔 떠 있는 지휘관 창의 크기 기억 — 읽는 김에 지운다. 값은 따로 쓰지 않는다.
const LEGACY_WINDOW_RECT_KEY = "fleet-console.commanderWindow.rect";

/**
 * 같은 origin의 첫 그리기용 캐시. 원천은 settings.json(`general.commanderPlacement`)이고,
 * 서버 값을 받기 전·서버 읽기가 실패했을 때만 이 값을 쓴다.
 * 동적 포트에서는 재시작마다 origin이 바뀌어 옛 값이 보이지 않는다 — 그때는 기본 왼쪽이다.
 */
function readCache(): CommanderPlacement {
  try {
    if (typeof window === "undefined") return "left";
    // 고스팅 레일 잔재는 읽는 김에 지운다 — 값은 따로 쓰지 않는다.
    window.localStorage.removeItem(LEGACY_SIDE_KEY);
    window.localStorage.removeItem(RAIL_EXPANDED_KEY);
    window.localStorage.removeItem(LEGACY_WINDOW_RECT_KEY);
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return "left";
    const parsed: unknown = JSON.parse(raw);
    if (parsed === "left" || parsed === "right") return parsed;
    // 예전 저장값(사이드바·채팅 안)은 모두 왼쪽으로 모은다.
    window.localStorage.setItem(KEY, JSON.stringify("left"));
    return "left";
  } catch {
    return "left";
  }
}

function writeCache(next: CommanderPlacement): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 저장하지 못하면 이번 화면에서만 기억한다. */
  }
}

/** 서버가 마지막으로 확정해 준 값. loaded가 거짓이면 아직 받은 적 없다. 값 null은 키 없음(한 번도 저장된 적 없음)이다. */
interface ServerPlacement {
  readonly loaded: boolean;
  readonly value: CommanderPlacement | null;
}

function readServerPlacement(): ServerPlacement {
  try {
    const state = getGlobalSettingsStoreState().state;
    if (state === null || state === undefined) return { loaded: false, value: null };
    const value = state.commanderPlacement;
    return { loaded: true, value: value === "left" || value === "right" ? value : null };
  } catch {
    return { loaded: false, value: null };
  }
}

const initialServer = readServerPlacement();
let placement: CommanderPlacement = initialServer.loaded && initialServer.value !== null ? initialServer.value : readCache();
let serverSynced = initialServer.loaded;
/** 세션당 1회 이관이 나갔는지. 서버에 값이 없던 때의 캐시 저장은 한 번뿐이다. */
let migrated = false;
/** 서버에 아직 확정되지 않은 최근 의도. 실패해도 화면 값은 유지하고 서버 되돌림은 무시한다. */
let pending: CommanderPlacement | null = null;
let inflight = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function finishPersist(target: CommanderPlacement, ok: boolean): void {
  inflight = false;
  if (pending !== target) {
    // 그 사이 새 의도가 들어왔다 — 성공 여부와 무관하게 그것을 보낸다(직렬화).
    persist();
    return;
  }
  if (ok) pending = null;
  // 실패하면 pending을 남긴다 — 화면 값을 유지하고, 그 사이 들어오는 서버 되돌림을 무시한다.
  // 재시도는 사람이 같은 값을 다시 고를 때(set의 early-return 경로) 일어난다. 여기서 곧장
  // 다시 보내면 서버 장애 때 PUT을 무한히 쏘는 고리가 된다.
}

function persist(): void {
  if (inflight || pending === null) return;
  const target = pending;
  inflight = true;
  try {
    const result = setGlobalSettingsField("commanderPlacement", target);
    result.then(
      (ok) => finishPersist(target, ok),
      () => finishPersist(target, false),
    );
  } catch {
    finishPersist(target, false);
  }
}

function syncFromServer(): void {
  const server = readServerPlacement();
  // 저장 중인 동안의 스토어 변화(낙관 반영·성공 확정·실패 되돌림)는 이 저장의 메아리다.
  // 여기서 pending을 걷으면 실패 되돌림이 화면 값을 덮어버리므로, 확정은 finishPersist가 맡는다.
  if (!server.loaded || inflight) return;
  if (!serverSynced) {
    serverSynced = true;
    if (pending !== null) {
      // 서버 값이 오기 전에 사람이 이미 골랐다 — 그 의도가 먼저다.
      if (server.value === pending) pending = null;
      return;
    }
    if (server.value === null && !migrated && placement === "right") {
      // 서버에 한 번도 저장된 적 없음 — 이 origin의 캐시를 1회 이관한다.
      // 명시 저장 "left"는 value가 "left"라 여기로 오지 않는다 — 덮어쓰지 않는다.
      migrated = true;
      pending = placement;
      persist();
      return;
    }
  } else if (pending !== null) {
    if (server.value === pending) pending = null;
    else return;
  }
  if (server.value !== null && server.value !== placement) {
    // 서버가 값을 가진 뒤에는 캐시가 서버를 따른다.
    placement = server.value;
    writeCache(server.value);
    emit();
  }
  // 서버 값이 null인 채(키 소실 등) 들어오면 화면 값을 유지한다.
}

try {
  subscribeGlobalSettings(syncFromServer);
} catch {
  // 스토어 구독에 실패해도 캐시 값으로 동작한다.
}

/** 동기 읽기 — 서버 값을 받기 전·실패 시에는 같은 origin 캐시(기본 왼쪽)를 돌려준다. */
export function readCommanderPlacement(): CommanderPlacement {
  return placement;
}

export function setCommanderPlacement(next: CommanderPlacement): void {
  if (placement === next) {
    // 같은 값을 다시 고른 건 저장 재시도다 — 실패로 남았던 의도를 다시 보낸다.
    if (pending !== null) persist();
    return;
  }
  placement = next;
  writeCache(next);
  emit();
  pending = next;
  persist();
}

export function useCommanderPlacement(): CommanderPlacement {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => placement,
    () => placement,
  );
}

/* ── 옮기기 알림 — 목록이 반대쪽으로 넘어가며 언마운트돼도 살아남는다 ────── */

// 옮기는 순간 그 목록(사이드바 섹션·작업 탭 목표 섹션)이 언마운트되므로, 알림은 저장소 모듈에 두고 한 곳에서만 그린다.
export interface CommanderPlacementNotice {
  readonly commodoreId: string;
  readonly next: CommanderPlacement;
  readonly prev: CommanderPlacement;
  readonly nonce: number;
}

let notice: CommanderPlacementNotice | null = null;
const noticeListeners = new Set<() => void>();
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function emitNotice(): void {
  for (const listener of noticeListeners) listener();
}

export function notifyCommanderPlacementMoved(commodoreId: string, next: CommanderPlacement, prev: CommanderPlacement): void {
  if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
  notice = { commodoreId, next, prev, nonce: Date.now() };
  emitNotice();
  noticeTimer = setTimeout(() => { notice = null; noticeTimer = null; emitNotice(); }, 5000);
}

export function dismissCommanderPlacementNotice(): void {
  if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
  if (notice === null) return;
  notice = null;
  emitNotice();
}

export function useCommanderPlacementNotice(): CommanderPlacementNotice | null {
  return useSyncExternalStore(
    (listener) => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; },
    () => notice,
    () => null,
  );
}
