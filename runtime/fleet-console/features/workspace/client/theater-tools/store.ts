import { useMemo, useSyncExternalStore } from "react";

import { readCommodoreList, subscribeCommodoreList } from "../../../commodore/client/commodore-list.js";
import { isCommodoreToolsConversationSelected, subscribeCommodoreToolsConversation } from "../../../commodore/client/commodore-conversation.js";
import {
  resolveCommodoreToolTheater,
  type CommodoreToolId,
  type CommodoreToolTheaterResolution,
} from "../../shared/commodore-tool-theater.js";

const STORAGE_PREFIX = "fleet-console.commodore-tool-theater.";

function storageKey(commodoreId: string, tool: CommodoreToolId): string {
  return `${STORAGE_PREFIX}${commodoreId}.${tool}`;
}

/** 저장된 선택 — 등록 목록과 무관한 원값이다. 판정은 resolve가 맡는다. */
export function readStoredCommodoreToolTheater(commodoreId: string, tool: CommodoreToolId): string | null {
  try {
    const value = localStorage.getItem(storageKey(commodoreId, tool));
    return value !== null && value !== "" ? value : null;
  } catch {
    return null;
  }
}

const storeListeners = new Set<() => void>();

function emitStore(): void {
  for (const listener of [...storeListeners]) listener();
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => { storeListeners.delete(listener); };
}

/** 패널 메뉴의 선택 — 그 패널만 이 Theater로 옮긴다. */
export function selectCommodoreToolTheater(commodoreId: string, tool: CommodoreToolId, theaterId: string): void {
  try {
    localStorage.setItem(storageKey(commodoreId, tool), theaterId);
  } catch { /* ignore */ }
  emitStore();
}

export interface CommodoreToolTheaterRow {
  readonly theaterId: string;
  readonly label: string;
  readonly missing: boolean;
}

export interface CommodoreToolTheaterState {
  /** 지금 가운데가 사령관 대화인가 — 아니면 이 값들을 쓰지 않는다. */
  readonly active: boolean;
  /** 그 사령관의 등록 Theater(폴더가 사라진 것도 함께 — 메뉴는 고를 것만 건넨다). */
  readonly theaters: readonly CommodoreToolTheaterRow[];
  readonly stored: string | null;
  /** active가 false면 null — 호출자는 ctx의 Theater를 그대로 쓴다. */
  readonly resolution: CommodoreToolTheaterResolution | null;
  readonly select: (theaterId: string) => void;
}

/**
 * (사령관, 도구)의 Theater — 타일 머리와 패널 본문이 같은 값을 읽는다. 호스트가 타일 문맥에
 * 실은 값과 패널이 직접 읽는 값이 갈라지지 않게, 판정의 유일한 출처는 이 훅이다.
 */
export function useCommodoreToolTheater(commodoreId: string | null, tool: CommodoreToolId | null): CommodoreToolTheaterState {
  const conversationActive = useSyncExternalStore(
    subscribeCommodoreToolsConversation,
    isCommodoreToolsConversationSelected,
    () => false,
  );
  const rows = useSyncExternalStore(
    subscribeCommodoreList,
    () => readCommodoreList().find((row) => row.commodoreId === commodoreId)?.theaters ?? [],
    () => [],
  );
  const stored = useSyncExternalStore(
    subscribeStore,
    () => (commodoreId !== null && tool !== null ? readStoredCommodoreToolTheater(commodoreId, tool) : null),
    () => null,
  );
  return useMemo<CommodoreToolTheaterState>(() => {
    const active = conversationActive && commodoreId !== null && tool !== null;
    const theaters: readonly CommodoreToolTheaterRow[] = rows.map((row) => ({
      theaterId: row.theaterId,
      label: row.label,
      missing: row.status === "missing",
    }));
    if (!active) return { active: false, theaters, stored, resolution: null, select: () => undefined };
    const resolution = resolveCommodoreToolTheater(
      stored,
      theaters.map((theater) => ({ theaterId: theater.theaterId, status: theater.missing ? "missing" as const : "available" as const })),
    );
    const owner = commodoreId;
    const selected = tool;
    return {
      active: true,
      theaters,
      stored,
      resolution,
      select: (theaterId: string) => selectCommodoreToolTheater(owner, selected, theaterId),
    };
  }, [conversationActive, commodoreId, tool, rows, stored]);
}
