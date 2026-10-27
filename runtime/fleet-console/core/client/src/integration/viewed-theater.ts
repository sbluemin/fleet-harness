import { useSyncExternalStore } from "react";

import { getState, subscribe } from "./store.js";
import { getViewModeSnapshot, subscribeViewMode } from "./view-mode-store.js";
import { getMobileDestination, getMobileListTheaterId, subscribeMobileState } from "../chrome/mobile/mobile-store.js";
import { readMobileObjectiveId } from "../chrome/mobile/mobile-objective-url.js";
import { readCommodoreList, readMobileCommodoreId, readZoneCommodore, subscribeCommodoreList } from "../../../../features/commodore/client/commodore-list.js";
import { getConversationSubject, subscribeConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { getConversationSurface, subscribeConversationSurface } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { readTheaterInboxState, subscribeTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";

/**
 * 등록된 Theater 가 있으면 그 폴더가 지금 보는 곳이다. 한 사령관이 Theater 를 여러 개 가질 수 있어,
 * 소유 사령관으로 먼저 고르면 다른 폴더의 목표가 첫 Theater 로 붙는다. 등록되지 않은 해시만 소유 사령관 Theater 로 대체한다.
 */
function isRegisteredTheater(state: ReturnType<typeof getState>, theaterId: unknown): theaterId is string {
  return typeof theaterId === "string" && state.theaters.some((theater) => theater.id === theaterId);
}

/**
 * 목표의 극장 문맥은 그 사령관의 등록 Theater 목록에서만 고른다. 전역 단일 소유(theater.commodore)는 쓰지 않는다.
 * 저장된 id가 그 목록에 있으면 그 id다. 미등록 해시이고 등록 Theater가 하나면 그 하나다.
 * 없거나 여럿인데 해시뿐이면 null — 목표 탭은 Theater 없이 열리고, 경로가 필요한 도구는 고르지 않는다.
 */
function theaterOfCommodore(state: ReturnType<typeof getState>, commodoreId: string, hinted: string | null): string | null {
  const owned = readCommodoreList()
    .find((commodore) => commodore.commodoreId === commodoreId)
    ?.theaters.map((theater) => theater.theaterId)
    .filter((theaterId, index, ids) => isRegisteredTheater(state, theaterId) && ids.indexOf(theaterId) === index) ?? [];
  if (hinted !== null && owned.includes(hinted)) return hinted;
  if (hinted !== null && isRegisteredTheater(state, hinted)) return owned.length === 0 ? hinted : null;
  if (owned.length === 1) return owned[0] ?? null;
  return null;
}

function visibleTheaterOf(state: ReturnType<typeof getState>, record: { readonly commodoreId?: unknown; readonly theaterId?: unknown } | undefined): string | null {
  if (!record) return null;
  const hinted = typeof record.theaterId === "string" ? record.theaterId : null;
  if (typeof record.commodoreId === "string") return theaterOfCommodore(state, record.commodoreId, hinted);
  return hinted !== null && isRegisteredTheater(state, hinted) ? hinted : null;
}

/** Mount 상태가 아니라 지금 화면에 선 대화의 소속이다. 빈 칸에는 임의의 Theater를 붙이지 않는다. */
export function getViewedTheaterId(): string | null {
  const state = getState();
  if (getViewModeSnapshot().effective === "mobile") {
    const objectiveId = readMobileObjectiveId();
    const objectiveRecord = state.objectiveRecords.find((candidate) => candidate.id === objectiveId);
    if (objectiveRecord) return visibleTheaterOf(state, objectiveRecord);
    const destination = getMobileDestination();
    const requested = (destination.kind === "plugin" ? destination.params?.theaterId : undefined) ?? getMobileListTheaterId();
    return state.theaters.find((theater) => theater.id === requested)?.id ?? state.theaters[0]?.id ?? null;
  }
  // 새 세션은 보던 대화를 걷어도 자체 컨텍스트를 유지한다. Theater 가 없으면 이전 대화로 되돌리지 않는다.
  const newSession = state.newSession;
  if (newSession !== null) {
    return state.theaters.find((theater) => theater.id === newSession.theaterId)?.id ?? null;
  }
  const surface = getConversationSurface();
  if (surface !== null) {
    const theaterId = typeof surface.params.theaterId === "string" ? surface.params.theaterId : null;
    const commodoreId = surface.params.commodoreId;
    if (typeof commodoreId === "string") return theaterOfCommodore(state, commodoreId, theaterId);
    return theaterId !== null && isRegisteredTheater(state, theaterId) ? theaterId : null;
  }
  const inbox = readTheaterInboxState();
  if (inbox !== null) return state.theaters.some((theater) => theater.id === inbox.theaterId) ? inbox.theaterId : null;
  const subjectId = getConversationSubject()?.id ?? state.activeObjectiveId;
  return visibleTheaterOf(state, state.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === subjectId));
}

/** 화면이 명시한 도구 소유자만 전달한다. Theater 공유 목록에서 임의로 고르지 않는다. */
export function getViewedCommodoreId(): string | null {
  const state = getState();
  if (getViewModeSnapshot().effective === "mobile") {
    const objectiveId = readMobileObjectiveId();
    const objective = state.objectiveRecords.find((row) => row.id === objectiveId);
    if (objective) return objective.commodoreId;
    const destination = getMobileDestination();
    if (destination.kind === "plugin" && destination.params?.commodoreId) return destination.params.commodoreId;
    return readMobileCommodoreId();
  }
  if (state.newSession !== null) return state.newSession.commodoreId ?? null;
  const surface = getConversationSurface();
  if (surface !== null) return typeof surface.params.commodoreId === "string" ? surface.params.commodoreId : null;
  if (readTheaterInboxState() !== null) return readZoneCommodore();
  const subjectId = getConversationSubject()?.id ?? state.activeObjectiveId;
  return state.objectiveRecords.find((row) => row.id === subjectId)?.commodoreId ?? null;
}

export function useViewedCommodoreId(): string | null {
  return useSyncExternalStore(subscribeViewedTheater, getViewedCommodoreId, () => null);
}

export function subscribeViewedTheater(listener: () => void): () => void {
  const offs = [subscribe(listener), subscribeConversationSubject(listener), subscribeConversationSurface(listener), subscribeTheaterInbox(listener), subscribeMobileState(listener), subscribeViewMode(listener), subscribeCommodoreList(listener)];
  return () => { for (const off of offs) off(); };
}

export function useViewedTheaterId(): string | null {
  return useSyncExternalStore(subscribeViewedTheater, getViewedTheaterId, () => null);
}
