import { useSyncExternalStore } from "react";

import { getState, subscribe } from "./store.js";
import { getViewModeSnapshot, subscribeViewMode } from "./view-mode-store.js";
import { getMobileDestination, getMobileListTheaterId, subscribeMobileState } from "../chrome/mobile/mobile-store.js";
import { readMobileObjectiveId } from "../chrome/mobile/mobile-objective-url.js";
import { getConversationSubject, subscribeConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { getConversationSurface, subscribeConversationSurface } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { readTheaterInboxState, subscribeTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";

/**
 * 등록된 Theater 가 있으면 그 폴더가 지금 보는 곳이다. 한 사령관이 Theater 를 여러 개 가질 수 있어,
 * 소유 사령관으로 먼저 고르면 다른 폴더의 목표가 첫 Theater 로 붙는다. 등록되지 않은 해시만 소유 사령관 Theater 로 대체한다.
 */
function visibleTheaterOf(state: ReturnType<typeof getState>, record: { readonly commodoreId?: unknown; readonly theaterId?: unknown } | undefined): string | null {
  if (!record) return null;
  if (typeof record.theaterId === "string" && state.theaters.some((theater) => theater.id === record.theaterId)) return record.theaterId;
  if (typeof record.commodoreId === "string") return state.theaters.find((theater) => theater.commodore?.id === record.commodoreId)?.id ?? null;
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
  const surface = getConversationSurface();
  if (surface !== null) {
    const theaterId = surface.params.theaterId;
    if (typeof theaterId === "string" && state.theaters.some((theater) => theater.id === theaterId)) return theaterId;
    const commodoreId = surface.params.commodoreId;
    if (typeof commodoreId === "string") return state.theaters.find((theater) => theater.commodore?.id === commodoreId)?.id ?? null;
    return null;
  }
  const inbox = readTheaterInboxState();
  if (inbox !== null) return state.theaters.some((theater) => theater.id === inbox.theaterId) ? inbox.theaterId : null;
  const subjectId = getConversationSubject()?.id ?? state.activeObjectiveId;
  return visibleTheaterOf(state, state.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === subjectId));
}

export function subscribeViewedTheater(listener: () => void): () => void {
  const offs = [subscribe(listener), subscribeConversationSubject(listener), subscribeConversationSurface(listener), subscribeTheaterInbox(listener), subscribeMobileState(listener), subscribeViewMode(listener)];
  return () => { for (const off of offs) off(); };
}

export function useViewedTheaterId(): string | null {
  return useSyncExternalStore(subscribeViewedTheater, getViewedTheaterId, () => null);
}
