import { useSyncExternalStore } from "react";

import type { ClientConsoleEventsCapability } from "../../workspace/shared/navigation-ports.js";
import type { CommodoreLastMessage, CommodoreTheaterSummary, ConsoleCommodoreSummary } from "../shared/contracts/theaters.js";
import type { CommodoreEvent } from "../shared/contracts/types.js";
import { commodoreLastMessage } from "../shared/last-message.js";
import { fetchCommodores } from "./theaters-api.js";

/**
 * 사령관 목록 — `fetchCommodores()` 와 commodore SSE 의 state/run 이 다시 읽게 한다.
 * 섹션 루프의 원천은 Theater 목록이 아니라 이 목록이다.
 */

const COMMODORE_CHANNEL = "commodore";

let commodores: readonly ConsoleCommodoreSummary[] = [];
let loaded = false;
let zoneCommodoreId: string | null = null;
let mobileCommodoreId: string | null = null;
const listeners = new Set<() => void>();
let refreshFlight: Promise<void> | null = null;
let refreshAgain = false;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function readCommodoreList(): readonly ConsoleCommodoreSummary[] {
  return commodores;
}

export function commodoreListLoaded(): boolean {
  return loaded;
}

export function subscribeCommodoreList(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCommodoreList(): readonly ConsoleCommodoreSummary[] {
  return useSyncExternalStore(subscribeCommodoreList, readCommodoreList, readCommodoreList);
}

/** 작전 구역 Theater 탭이 어느 사령관을 보는지. Inbox 의 theaterId 와 별개다. */
export function setZoneCommodore(commodoreId: string | null): void {
  if (zoneCommodoreId === commodoreId) return;
  zoneCommodoreId = commodoreId;
  emit();
}

export function readZoneCommodore(): string | null {
  return zoneCommodoreId;
}

export function useZoneCommodore(): string | null {
  return useSyncExternalStore(subscribeCommodoreList, readZoneCommodore, readZoneCommodore);
}

export function selectMobileCommodore(commodoreId: string | null): void {
  if (mobileCommodoreId === commodoreId) return;
  mobileCommodoreId = commodoreId;
  emit();
}

export function readMobileCommodoreId(): string | null {
  return mobileCommodoreId;
}

/**
 * 폰 사령관 화면의 주인. 그 Theater를 가진 사령관이 하나면 그 사령관이고, 없거나 여럿이면 칩에서 고른 사령관, 그것도 없으면 목록의 첫 사령관이다.
 * 미소속 Theater는 주인을 만들지 않는다.
 */
export function mobileCommodoreTarget(theaterId: string | null): string | null {
  const owners = theaterId ? commodores.filter((row) => row.theaters.some((theater) => theater.theaterId === theaterId)) : [];
  if (owners.length === 1) return owners[0]?.commodoreId ?? null;
  return mobileCommodoreId ?? commodores[0]?.commodoreId ?? null;
}

export function useMobileCommodoreSelection(): string | null {
  return useSyncExternalStore(subscribeCommodoreList, readMobileCommodoreId, readMobileCommodoreId);
}

export function replaceCommodoreList(next: readonly ConsoleCommodoreSummary[]): void {
  commodores = next;
  loaded = true;
  emit();
}

function noteLastMessage(commodoreId: string, last: CommodoreLastMessage | null): void {
  if (!last) return;
  let changed = false;
  const next = commodores.map((row) => {
    if (row.commodoreId !== commodoreId || (row.last && row.last.at > last.at)) return row;
    changed = true;
    return { ...row, last };
  });
  if (!changed) return;
  commodores = next;
  emit();
}

export function refreshCommodoreList(): Promise<void> {
  if (refreshFlight) {
    refreshAgain = true;
    return refreshFlight;
  }
  const run = async (): Promise<void> => {
    do {
      refreshAgain = false;
      try {
        const result = await fetchCommodores();
        commodores = result.commodores;
      } catch {
        // 목록이 비어도 기록의 commodoreId 로 섹션은 남는다.
      } finally {
        loaded = true;
        emit();
      }
    } while (refreshAgain);
  };
  refreshFlight = run().finally(() => { refreshFlight = null; });
  return refreshFlight;
}

export function installCommodoreList(events: ClientConsoleEventsCapability): () => void {
  void refreshCommodoreList();
  const off = events.subscribe(COMMODORE_CHANNEL, (payload) => {
    const event = payload as CommodoreEvent | null;
    if (event?.op === "removed") {
      commodores = commodores.filter((row) => row.commodoreId !== event.commodoreId);
      if (zoneCommodoreId === event.commodoreId) zoneCommodoreId = null;
      if (mobileCommodoreId === event.commodoreId) mobileCommodoreId = null;
      emit();
      void refreshCommodoreList();
    }
    if (event?.op === "state" || event?.op === "run") void refreshCommodoreList();
    // 대화의 마지막 말은 목록을 다시 읽지 않고 그 행만 갈아 끼운다 — 기록 줄은 턴마다 여럿 온다.
    if (event?.op === "transcript") noteLastMessage(event.commodoreId, commodoreLastMessage(event.entry));
  });
  const offReconnect = events.onReconnect?.(() => { void refreshCommodoreList(); });
  return () => { off(); offReconnect?.(); };
}

/** 섹션 머리 이름. 별칭, 없으면 첫 Theater 이름, 없으면 현지화된 fallback. 서버 label 의 영문 Commodore 는 쓰지 않는다. */
export function commodoreSectionLabel(
  commodore: { readonly alias?: string; readonly theaters: readonly { readonly label: string }[] },
  fallbackLabel: string,
): string {
  return commodore.alias || commodore.theaters.find((theater) => theater.label)?.label || fallbackLabel;
}

export interface SidebarCommodore {
  readonly commodoreId: string;
  readonly label: string;
  readonly alias?: string;
  readonly theaters: readonly CommodoreTheaterSummary[];
}

/**
 * 목록에 있는 사령관과, 아직 목록에 없는 기록·그룹의 commodoreId.
 * 로드 전이나 지연으로 목록이 비어도 기록은 그 id 의 임시 섹션에 남는다.
 */
export function sidebarCommodores(
  listed: readonly ConsoleCommodoreSummary[],
  records: readonly { readonly commodoreId: string }[],
  groups: readonly { readonly commodoreId: string }[],
  fallbackLabel: string,
): readonly SidebarCommodore[] {
  const byId = new Map<string, SidebarCommodore>();
  for (const commodore of listed) {
    byId.set(commodore.commodoreId, {
      commodoreId: commodore.commodoreId,
      label: commodoreSectionLabel(commodore, fallbackLabel),
      ...(commodore.alias ? { alias: commodore.alias } : {}),
      theaters: commodore.theaters,
    });
  }
  const orphans: string[] = [];
  for (const row of [...records, ...groups]) {
    if (!row.commodoreId || byId.has(row.commodoreId) || orphans.includes(row.commodoreId)) continue;
    orphans.push(row.commodoreId);
  }
  orphans.sort();
  return [
    ...listed.map((commodore) => byId.get(commodore.commodoreId)!),
    ...orphans.map((commodoreId) => ({ commodoreId, label: fallbackLabel, theaters: [] as readonly CommodoreTheaterSummary[] })),
  ];
}

/** 모든 기록이 어느 섹션 id 에 들어가는지. 빠지면 그 기록 id 를 돌려준다. */
export function recordsMissingSection(
  records: readonly { readonly id: string; readonly commodoreId: string }[],
  sections: readonly { readonly commodoreId: string }[],
): readonly string[] {
  const ids = new Set(sections.map((section) => section.commodoreId));
  return records.filter((record) => !ids.has(record.commodoreId)).map((record) => record.id);
}

export function useSidebarCommodores(
  records: readonly { readonly commodoreId: string }[],
  groups: readonly { readonly commodoreId: string }[],
  fallbackLabel: string,
): readonly SidebarCommodore[] {
  const listed = useCommodoreList();
  return sidebarCommodores(listed, records, groups, fallbackLabel);
}
