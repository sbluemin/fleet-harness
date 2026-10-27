import { useSyncExternalStore } from "react";

import { getState, subscribe } from "./store.js";
import { getViewModeSnapshot, subscribeViewMode } from "./view-mode-store.js";
import { getMobileDestination, getMobileListTheaterId, subscribeMobileState } from "../chrome/mobile/mobile-store.js";
import { readMobileObjectiveId } from "../chrome/mobile/mobile-objective-url.js";
import { readCommodoreList, subscribeCommodoreList } from "../../../../features/commodore/client/commodore-list.js";
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
 * 목표의 theaterId가 등록 Theater가 아니면(사령관 objectives 폴더의 해시) 그 목표의 사령관이 가진
 * 등록 Theater로만 읽는다. cwd는 그대로 둔다. 같은 Theater를 여러 사령관이 가져도 다른 사령관의
 * Theater는 고르지 않는다. 그 사령관이 등록 Theater를 둘 이상 가지면, 저장된 id가 그중 하나일 때만 고른다.
 */
function theaterOfCommodore(state: ReturnType<typeof getState>, commodoreId: string, hinted: string | null): string | null {
  const owned = readCommodoreList()
    .find((commodore) => commodore.commodoreId === commodoreId)
    ?.theaters.map((theater) => theater.theaterId)
    .filter((theaterId, index, ids) => isRegisteredTheater(state, theaterId) && ids.indexOf(theaterId) === index) ?? [];
  if (hinted !== null && owned.includes(hinted)) return hinted;
  if (owned.length === 1) return owned[0] ?? null;
  if (owned.length === 0) return state.theaters.find((theater) => theater.commodore?.id === commodoreId)?.id ?? null;
  return null;
}

function visibleTheaterOf(state: ReturnType<typeof getState>, record: { readonly commodoreId?: unknown; readonly theaterId?: unknown } | undefined): string | null {
  if (!record) return null;
  if (isRegisteredTheater(state, record.theaterId)) return record.theaterId;
  if (typeof record.commodoreId === "string") return theaterOfCommodore(state, record.commodoreId, typeof record.theaterId === "string" ? record.theaterId : null);
  return null;
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
    const theaterId = surface.params.theaterId;
    if (isRegisteredTheater(state, theaterId)) return theaterId;
    const commodoreId = surface.params.commodoreId;
    if (typeof commodoreId === "string") return theaterOfCommodore(state, commodoreId, typeof theaterId === "string" ? theaterId : null);
    return null;
  }
  const inbox = readTheaterInboxState();
  if (inbox !== null) return state.theaters.some((theater) => theater.id === inbox.theaterId) ? inbox.theaterId : null;
  const subjectId = getConversationSubject()?.id ?? state.activeObjectiveId;
  return visibleTheaterOf(state, state.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === subjectId));
}

export function subscribeViewedTheater(listener: () => void): () => void {
  const offs = [subscribe(listener), subscribeConversationSubject(listener), subscribeConversationSurface(listener), subscribeTheaterInbox(listener), subscribeMobileState(listener), subscribeViewMode(listener), subscribeCommodoreList(listener)];
  return () => { for (const off of offs) off(); };
}

export function useViewedTheaterId(): string | null {
  return useSyncExternalStore(subscribeViewedTheater, getViewedTheaterId, () => null);
}
