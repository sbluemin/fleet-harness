import type { MentionTargetAddress } from "../../../execution/shared/composer-ports.js";

import { getState, openMobileNewSession, openNewSession, requestNewSessionFocus, seedNewSession } from "../../../../core/client/src/integration/store.js";
import { navigateConsoleRoute } from "../../../../core/client/src/integration/console-location.js";
import { getViewModeSnapshot } from "../../../../core/client/src/integration/view-mode-store.js";
import { getViewedTheaterId } from "../../../../core/client/src/integration/viewed-theater.js";
import { readNewSessionSelection } from "./new-session-preferences.js";
import { getConversationSurface } from "./conversation-surface-store.js";
import { getConversationSubject } from "./conversation-slots.js";
import { readCommodoreList, readMobileCommodoreId, readZoneCommodore } from "../../../commodore/client/commodore-list.js";

/**
 * 새 세션이 처음 고르는 Theater — 데스크톱 화면과 모바일 새 대화 시트가 같은 규칙을 쓴다:
 * ① 마지막으로 고른 Theater, ② 지금 보고 있는 Theater, ③ 목록 첫 Theater. 등록된 Theater 가 없으면 null —
 * 데스크톱 화면이 「Theater 추가…」를 먼저 세운다.
 */
export function resolveNewSessionTheaterId(): string | null {
  const ids = getState().theaters.map((theater) => theater.id);
  const remembered = readNewSessionSelection().theaterId;
  if (remembered !== null && ids.includes(remembered)) return remembered;
  const viewed = getViewedTheaterId();
  if (viewed !== null && ids.includes(viewed)) return viewed;
  return ids[0] ?? null;
}

const COMMODORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function commodoreUuid(id: string | null | undefined): string | null {
  return id && COMMODORE_UUID.test(id) ? id : null;
}

/**
 * 새 세션이 실을 사령관. Theater 칩은 후보를 제한하지 않고, 소유만 이 순서로 정한다.
 * ① 컴포저를 연 섹션, ② 가운데 사령관 대화와 지금 보는 기록, ③ 작전 구역·폰 칩, ④ 목록의 첫 사령관.
 * 팔레트·단축키가 예전에 담아 둔 값은 섹션이 아니다. 사령관이 하나도 없으면 null — 호출부는 지금처럼 새 사령관을 만들도록 둔다.
 */
export function resolveNewSessionCommodoreId(sectionCommodoreId?: string | null): string | null {
  const section = commodoreUuid(sectionCommodoreId);
  if (section) return section;
  const surface = getConversationSurface();
  const conversation = surface?.surfaceId === "commodore"
    ? commodoreUuid(typeof surface.params.commodoreId === "string" ? surface.params.commodoreId : null)
    : null;
  if (conversation) return conversation;
  const state = getState();
  const viewed = getConversationSubject()
    ?? state.objectiveRecords.find((record) => record.id === state.activeObjectiveId)
    ?? null;
  const recordOwner = commodoreUuid(viewed?.commodoreId);
  if (recordOwner) return recordOwner;
  const picked = getViewModeSnapshot().effective === "mobile" ? readMobileCommodoreId() : readZoneCommodore();
  return commodoreUuid(picked) ?? readCommodoreList()[0]?.commodoreId ?? null;
}

/**
 * 사이드바 맨 위 「+」·팔레트 「New Objective」·새 세션 단축키가 함께 쓰는 입구. 여는 것만으로는 아무것도 만들지 않는다.
 * 이미 열려 있으면 고른 Theater 를 그대로 두고 컴포저로 돌아간다 — 쓰던 문장과 고른 자리를 단축키가 갈아치우지 않는다.
 */
/** 섹션 머리의 「+」. 기본 Theater 는 그 사령관에 추가한 첫 Theater 이고, 없으면 마지막에 쓴 Theater 다. */
export function openCommodoreNewSession(commodoreId: string): void {
  const added = readCommodoreList().find((commodore) => commodore.commodoreId === commodoreId)?.theaters[0]?.theaterId ?? null;
  const remembered = readNewSessionSelection().theaterId;
  const ids = getState().theaters.map((theater) => theater.id);
  const theaterId = added ?? (remembered !== null && ids.includes(remembered) ? remembered : null);
  openNewSession({ theaterId, commodoreId, commodoreFromSection: true });
}

export function openDefaultNewSession(): void {
  if (getState().newSession !== null) {
    requestNewSessionFocus();
    return;
  }
  const commodoreId = resolveNewSessionCommodoreId();
  openNewSession({ theaterId: resolveNewSessionTheaterId(), ...(commodoreId ? { commodoreId } : {}) });
}

/**
 * 플러그인·부유 위젯의 `composer.open` — 새 세션 컴포저를 열고 caret 을 넣는다. 폰에서는 새 대화 시트, 데스크톱에서는
 * 새 세션 화면이다(ObjectiveRecords 밖이면 그리로 옮긴다). `draft` 는 문면을 갈아치우고 보내지 않는다. 행선지는 '@'로 고른 것과 같다.
 */
export function openNewSessionComposer(options?: {
  readonly draft?: string;
  readonly mentionObjectiveId?: string;
  readonly mentionTarget?: MentionTargetAddress;
}): void {
  const draft = typeof options?.draft === "string" ? options.draft : null;
  const mentionObjectiveId = options?.mentionObjectiveId ?? null;
  const mentionTarget = options?.mentionTarget ?? null;
  if (draft !== null || mentionObjectiveId !== null || mentionTarget !== null) seedNewSession({ draft, mentionObjectiveId, mentionTarget });
  if (getViewModeSnapshot().effective === "mobile") {
    openMobileNewSession();
    return;
  }
  if (!getState().objectiveRecordsViewActive) navigateConsoleRoute("/objectives");
  openDefaultNewSession();
}
