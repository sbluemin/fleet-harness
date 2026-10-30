import { useSyncExternalStore } from "react";

import type { ClientConsoleEventsCapability } from "../../workspace/shared/navigation-ports.js";
import type { CommodoreLastMessage, CommodoreTheaterSummary, ConsoleCommodoreSummary } from "../shared/contracts/theaters.js";
import type { CommodoreEvent } from "../shared/contracts/types.js";
import { commodoreLastMessage } from "../shared/last-message.js";
import { fetchCommodores } from "./theaters-api.js";
import { wasCommodoreRemoved } from "./commodore-delete-events.js";
import { COMMODORE_SIDEBAR_CHANNEL, EMPTY_SIDEBAR_LAYOUT, type CommodoreSidebarLayout } from "../shared/contracts/sidebar-layout.js";

/**
 * 사령관 목록 — `fetchCommodores()` 와 commodore SSE 의 state/run 이 다시 읽게 한다.
 * 섹션 루프의 원천은 Theater 목록이 아니라 이 목록이다.
 */

const COMMODORE_CHANNEL = "commodore";

let commodores: readonly ConsoleCommodoreSummary[] = [];
let loaded = false;
let sidebarLayout: CommodoreSidebarLayout = EMPTY_SIDEBAR_LAYOUT;
const readSidebarLayout = () => sidebarLayout;
export function useCommodoreSidebarLayout(): CommodoreSidebarLayout {
  return useSyncExternalStore(subscribeCommodoreList, readSidebarLayout, readSidebarLayout);
}
export function replaceCommodoreSidebarLayout(next: CommodoreSidebarLayout): void {
  sidebarLayout = next;
  emit();
}
let zoneCommodoreId: string | null = null;
const MOBILE_COMMODORE_KEY = "fleet.mobile.commodore";
let mobileCommodoreId: string | null = readSavedMobileCommodore();

function readSavedMobileCommodore(): string | null {
  try { return window.localStorage.getItem(MOBILE_COMMODORE_KEY); } catch { return null; }
}

function saveMobileCommodore(commodoreId: string | null): void {
  mobileCommodoreId = commodoreId;
  try {
    if (commodoreId === null) window.localStorage.removeItem(MOBILE_COMMODORE_KEY);
    else window.localStorage.setItem(MOBILE_COMMODORE_KEY, commodoreId);
  } catch { /* 저장소를 쓸 수 없어도 이번 화면의 선택은 유지한다. */ }
}

function forgetMissingMobileCommodore(): void {
  if (mobileCommodoreId !== null && !commodores.some((row) => row.commodoreId === mobileCommodoreId)) saveMobileCommodore(null);
}
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
  saveMobileCommodore(commodoreId);
  emit();
}

export function readMobileCommodoreId(): string | null {
  // 목록 확인 전의 저장값을 목적지 주소로 옮기지 않는다. 삭제된 사령관이 주소로 되살아날 수 있다.
  return commodores.some((row) => row.commodoreId === mobileCommodoreId) ? mobileCommodoreId : null;
}

export function useMobileCommodoreSelection(): string | null {
  return useSyncExternalStore(subscribeCommodoreList, readMobileCommodoreId, readMobileCommodoreId);
}

export function replaceCommodoreList(next: readonly ConsoleCommodoreSummary[]): void {
  commodores = next.filter((row) => !wasCommodoreRemoved(row.commodoreId));
  forgetMissingMobileCommodore();
  loaded = true;
  emit();
}

function noteLastMessage(commodoreId: string, last: CommodoreLastMessage | null): void {
  if (!last) return;
  let changed = false;
  const next = commodores.map((row) => {
    if (row.commodoreId !== commodoreId || (row.last && row.last.at > last.at)) return row;
    changed = true;
    return { ...row, last, ...(last.from === "commodore" ? { lastResponse: last } : {}) };
  });
  if (!changed) return;
  commodores = next.filter((row) => !wasCommodoreRemoved(row.commodoreId));
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
        commodores = result.commodores.filter((row) => !wasCommodoreRemoved(row.commodoreId));
        sidebarLayout = result.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT;
        forgetMissingMobileCommodore();
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
      if (mobileCommodoreId === event.commodoreId) saveMobileCommodore(null);
      emit();
      void refreshCommodoreList();
    }
    if (event?.op === "state" || event?.op === "run") void refreshCommodoreList();
    // 대화의 마지막 말은 목록을 다시 읽지 않고 그 행만 갈아 끼운다 — 기록 줄은 턴마다 여럿 온다.
    if (event?.op === "transcript") noteLastMessage(event.commodoreId, commodoreLastMessage(event.entry));
  });
  const offReconnect = events.onReconnect?.(() => { void refreshCommodoreList(); });
  const offSidebar = events.subscribe(COMMODORE_SIDEBAR_CHANNEL, () => { void refreshCommodoreList(); });
  return () => { off(); offSidebar(); offReconnect?.(); };
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
  readonly lastResponse?: CommodoreLastMessage;
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
      ...(commodore.lastResponse ? { lastResponse: commodore.lastResponse } : {}),
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

export function useCommodoreListLoaded(): boolean {
  return useSyncExternalStore(subscribeCommodoreList, commodoreListLoaded, commodoreListLoaded);
}

/** 목록이 처음 닿기 전에는 섹션을 세우지 않는다 — 기록만으로 세운 섹션은 이름·대화가 없는 기본값으로 보인다. */
export function useSidebarCommodores(
  records: readonly { readonly commodoreId: string }[],
  groups: readonly { readonly commodoreId: string }[],
  fallbackLabel: string,
): readonly SidebarCommodore[] {
  const listed = useCommodoreList();
  const loaded = useCommodoreListLoaded();
  return loaded ? sidebarCommodores(listed, records, groups, fallbackLabel) : [];
}
