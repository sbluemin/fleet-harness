import { useSyncExternalStore } from "react";

import { createServerSyncedValue } from "../commander-tab/commander-server-sync.js";

/**
 * 사이드바에서 지휘관 목록이 펼쳐진 사령관 묶음 — 이 브라우저(localStorage)에 기억해 새로고침·재시작 뒤에도 유지한다.
 * 사령관을 옮길 때마다(`noteCommanderNavigated`) 정해지고, 자기 대화가 서 있는 활성 사령관을 다시 누르면(`reselectCommander`) 접힌다.
 * 저장이 막히면 이번 화면에서만 기억한다.
 */
const OPEN_KEY = "fleet-console.sidebar.commanderExpanded";
// 사령관별 접힘 아코디언이 쓰던 키 — 읽는 김에 지운다. 값은 따로 쓰지 않는다.
const LEGACY_SECTIONS_KEY = "fleet-console.sidebar.commanderSections.collapsed";
const KEEP_KEY = "fleet-console.commanderTab.keepExpanded";

// ── 펼침 유지(옵트인) — 정렬·접힘·배치와 같은 글로벌 설정이다 ────────────────────────────────────────
// 같은 origin의 localStorage는 첫 그리기용 캐시로만 쓰고, 원천은 settings.json(`general.commanderKeepExpanded`)이다.

function parseKeep(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readKeepCache(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEEP_KEY) === "true";
  } catch {
    return false;
  }
}

function writeKeepCache(next: boolean): void {
  try {
    window.localStorage.setItem(KEEP_KEY, next ? "true" : "false");
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
}

const syncedKeep = createServerSyncedValue<boolean>({
  field: "commanderKeepExpanded",
  defaultValue: false,
  readCache: readKeepCache,
  writeCache: writeKeepCache,
  parseServerValue: parseKeep,
  equal: (left, right) => left === right,
  isDefault: (value) => !value,
});

/** 동기 읽기 — 서버 값을 받기 전·실패 시에는 같은 origin 캐시(기본 꺼짐)를 돌려준다. */
export function readCommanderKeepExpanded(): boolean {
  return syncedKeep.get();
}

export function setCommanderKeepExpanded(next: boolean): void {
  syncedKeep.set(next);
}

export function useCommanderKeepExpanded(): boolean {
  return useSyncExternalStore(syncedKeep.subscribe, syncedKeep.get, syncedKeep.get);
}

// ── 펼침 묶음 ──────────────────────────────────────────────────────────────────────────────────────

function readOpen(): ReadonlySet<string> {
  try {
    if (typeof window === "undefined") return new Set();
    window.localStorage.removeItem(LEGACY_SECTIONS_KEY);
    const raw = window.localStorage.getItem(OPEN_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

let open: ReadonlySet<string> = readOpen();
const listeners = new Set<() => void>();

function commit(next: ReadonlySet<string>): void {
  if (next.size === open.size && [...next].every((id) => open.has(id))) return;
  open = next;
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
  for (const listener of listeners) listener();
}

/**
 * 활성 사령관이 바뀌었다(이동). 펼침 유지가 켜져 있으면 이동한 사령관을 묶음에 더하고 나머지는 그대로 둔다.
 * 꺼져 있으면 이동한 사령관만 펼친다. 이미 그 묶음이면 바뀌는 것이 없다.
 */
export function noteCommanderNavigated(commodoreId: string, keepExpanded: boolean): void {
  commit(keepExpanded ? new Set([...open, commodoreId]) : new Set([commodoreId]));
}

/**
 * 자기 대화가 서 있는 활성 사령관을 한 번 더 눌렀다. 펼침 유지가 켜져 있으면 그 사령관만 접고(접혀 있으면 다시 펼친다 — 활성인데 열 길이 없는
 * 막다른 상태를 만들지 않는다), 꺼져 있으면 접지 않는다. 지휘관 대화를 보다가 머리를 눌러 돌아오는 이동은 부르는 쪽이 먼저 걸러 펼침을 둔다.
 */
export function reselectCommander(commodoreId: string, keepExpanded: boolean): void {
  if (!keepExpanded) {
    if (!open.has(commodoreId)) commit(new Set([commodoreId]));
    return;
  }
  const next = new Set(open);
  if (next.has(commodoreId)) next.delete(commodoreId);
  else next.add(commodoreId);
  commit(next);
}

/** 그 사령관의 목록을 펼친다 — 다른 사령관은 건드리지 않는다. 목록을 왼쪽으로 옮겼을 때 옮겨 간 목록이 바로 보이게 한다. */
export function ensureCommanderExpanded(commodoreId: string): void {
  if (open.has(commodoreId)) return;
  commit(new Set([...open, commodoreId]));
}

export function useCommanderExpanded(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => open,
    () => open,
  );
}
