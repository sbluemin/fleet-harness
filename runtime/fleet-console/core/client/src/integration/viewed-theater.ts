import { useSyncExternalStore } from "react";

import { getState, subscribe } from "./store.js";
import { getViewModeSnapshot, subscribeViewMode } from "./view-mode-store.js";
import { getMobileDestination, getMobileListTheater, subscribeMobileState } from "../chrome/mobile/mobile-store.js";
import { readMobileObjectiveId } from "../chrome/mobile/mobile-objective-url.js";
import { readCommodoreList, readMobileCommodoreId, readZoneCommodore, subscribeCommodoreList } from "../../../../features/commodore/client/commodore-list.js";
import { getConversationSubject, subscribeConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { getConversationSurface, subscribeConversationSurface } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { readTheaterInboxState, subscribeTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";

/**
 * 목표의 극장 문맥은 그 사령관의 사용 가능한 폴더 목록에서만 고른다. Theater 에서 주인 사령관을 찾지 않는다.
 * 저장된 id가 그 목록에 있으면 그 id다. 옛 id이고 폴더가 하나면 그 하나다.
 * 없거나 여럿인데 현재 목록에 없는 id면 null — 경로가 필요한 도구는 임의로 고르지 않는다.
 */
function theaterOfCommodore(commodoreId: string, hinted: string | null): string | null {
  const commodores = readCommodoreList();
  const owned = commodores
    .find((commodore) => commodore.commodoreId === commodoreId)
    ?.theaters.filter((theater) => theater.status === "available").map((theater) => theater.theaterId) ?? [];
  if (hinted !== null && owned.includes(hinted)) return hinted;
  // 다른 사령관의 알려진 폴더를 옛 목표 해시로 오해해 현재 폴더로 바꾸지 않는다.
  if (hinted !== null && commodores.some((row) => row.theaters.some((theater) => theater.theaterId === hinted))) return null;
  if (owned.length === 1) return owned[0] ?? null;
  return null;
}

function visibleTheaterOf(record: { readonly commodoreId?: unknown; readonly theaterId?: unknown } | undefined): string | null {
  if (!record) return null;
  const hinted = typeof record.theaterId === "string" ? record.theaterId : null;
  if (typeof record.commodoreId === "string") return theaterOfCommodore(record.commodoreId, hinted);
  return null;
}

/** Mount 상태가 아니라 지금 화면에 선 대화의 소속이다. 빈 칸에는 임의의 Theater를 붙이지 않는다. */
export function getViewedTheaterId(): string | null {
  const state = getState();
  if (getViewModeSnapshot().effective === "mobile") {
    const objectiveId = readMobileObjectiveId();
    const objectiveRecord = state.objectiveRecords.find((candidate) => candidate.id === objectiveId);
    if (objectiveRecord) return visibleTheaterOf(objectiveRecord);
    const destination = getMobileDestination();
    const addressed = destination.kind === "plugin" ? destination.params : undefined;
    const requested = (typeof addressed?.theaterId === "string" ? { commodoreId: typeof addressed.commodoreId === "string" ? addressed.commodoreId : null, theaterId: addressed.theaterId } : null)
      ?? getMobileListTheater();
    const commodoreId = requested?.commodoreId ?? getViewedCommodoreId();
    if (commodoreId) return theaterOfCommodore(commodoreId, requested?.theaterId ?? null);
    return null;
  }
  // 새 세션은 보던 대화를 걷어도 자체 컨텍스트를 유지한다. Theater 가 없으면 이전 대화로 되돌리지 않는다.
  const newSession = state.newSession;
  if (newSession !== null) {
    return newSession.commodoreId ? theaterOfCommodore(newSession.commodoreId, newSession.theaterId) : null;
  }
  const surface = getConversationSurface();
  if (surface !== null) {
    const theaterId = typeof surface.params.theaterId === "string" ? surface.params.theaterId : null;
    const commodoreId = surface.params.commodoreId;
    if (typeof commodoreId === "string") return theaterOfCommodore(commodoreId, theaterId);
    return null;
  }
  const inbox = readTheaterInboxState();
  if (inbox !== null) {
    const commodoreId = readZoneCommodore();
    return commodoreId ? theaterOfCommodore(commodoreId, inbox.theaterId) : null;
  }
  const subjectId = getConversationSubject()?.id ?? state.activeObjectiveId;
  return visibleTheaterOf(state.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === subjectId));
}

const COMMODORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commodoreUuid = (id: unknown): string | null => (typeof id === "string" && COMMODORE_UUID.test(id) ? id : null);

/**
 * 지금 화면이 명시한 사령관 UUID — 사령관 하나에 걸린 표면(사령관 Inbox·목표·배지·도구)이 읽는 문맥이다.
 * Theater 에서 주인을 거꾸로 찾지 않고, Theater 공유 목록이나 사령관 목록에서 임의로 고르지도 않는다: 같은 폴더를 여러 사령관이
 * 함께 쓸 수 있으므로 Theater 는 사령관을 정하지 않는다.
 * 폰은 화면의 Objective, 목적지 주소, 칩에서 고른 사령관 순이다. 데스크톱은 새 세션의 사령관, 가운데 표면의 사령관, Theater Inbox 를 연
 * 동안의 작전 구역 사령관, 대화 대상 또는 활성 Objective 의 사령관 순이다. 모두 비면 null 이고, 부르는 쪽은 「사령관 없음」으로 다룬다 —
 * 첫 사령관 같은 대체가 꼭 필요한 소비자만 스스로 명시한다.
 */
export function getViewedCommodoreId(): string | null {
  const state = getState();
  if (getViewModeSnapshot().effective === "mobile") {
    const objectiveId = readMobileObjectiveId();
    const objective = state.objectiveRecords.find((row) => row.id === objectiveId);
    if (objective) return commodoreUuid(objective.commodoreId);
    const destination = getMobileDestination();
    const addressed = commodoreUuid(destination.kind === "plugin" ? destination.params?.commodoreId : undefined);
    if (addressed) return addressed;
    return commodoreUuid(readMobileCommodoreId());
  }
  if (state.newSession !== null) return commodoreUuid(state.newSession.commodoreId);
  const surface = getConversationSurface();
  if (surface !== null) return commodoreUuid(surface.params.commodoreId);
  if (readTheaterInboxState() !== null) return commodoreUuid(readZoneCommodore());
  const subjectId = getConversationSubject()?.id ?? state.activeObjectiveId;
  return commodoreUuid(state.objectiveRecords.find((row) => row.id === subjectId)?.commodoreId);
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
