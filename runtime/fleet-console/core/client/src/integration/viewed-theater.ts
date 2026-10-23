import { useSyncExternalStore } from "react";

import { getState, subscribe } from "./store.js";
import { getViewModeSnapshot, subscribeViewMode } from "./view-mode-store.js";
import { getMobileDestination, getMobileListTheaterId, subscribeMobileState } from "../chrome/mobile/mobile-store.js";
import { readMobileObjectiveId } from "../chrome/mobile/mobile-objective-url.js";
import { getConversationSubject, subscribeConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { getConversationSurface, subscribeConversationSurface } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { readTheaterInboxState, subscribeTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";

/** Mount 상태가 아니라 지금 화면에 선 대화의 소속이다. 빈 칸에는 임의의 Theater를 붙이지 않는다. */
export function getViewedTheaterId(): string | null {
  const state = getState();
  if (getViewModeSnapshot().effective === "mobile") {
    const objectiveId = readMobileObjectiveId();
    const objectiveRecord = state.objectiveRecords.find((candidate) => candidate.id === objectiveId);
    if (objectiveRecord) return objectiveRecord.theaterId;
    const destination = getMobileDestination();
    const requested = (destination.kind === "plugin" ? destination.params?.theaterId : undefined) ?? getMobileListTheaterId();
    return state.theaters.find((theater) => theater.id === requested)?.id ?? state.theaters[0]?.id ?? null;
  }
  const surface = getConversationSurface();
  if (surface !== null) {
    const theaterId = surface.params.theaterId;
    return typeof theaterId === "string" && state.theaters.some((theater) => theater.id === theaterId) ? theaterId : null;
  }
  const inbox = readTheaterInboxState();
  if (inbox !== null) return state.theaters.some((theater) => theater.id === inbox.theaterId) ? inbox.theaterId : null;
  const subjectId = getConversationSubject()?.id ?? state.activeObjectiveId;
  return state.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === subjectId)?.theaterId ?? null;
}

export function subscribeViewedTheater(listener: () => void): () => void {
  const offs = [subscribe(listener), subscribeConversationSubject(listener), subscribeConversationSurface(listener), subscribeTheaterInbox(listener), subscribeMobileState(listener), subscribeViewMode(listener)];
  return () => { for (const off of offs) off(); };
}

export function useViewedTheaterId(): string | null {
  return useSyncExternalStore(subscribeViewedTheater, getViewedTheaterId, () => null);
}
