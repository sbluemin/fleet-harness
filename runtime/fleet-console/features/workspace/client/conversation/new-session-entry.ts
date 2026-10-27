import type { MentionTargetAddress } from "../../../execution/shared/composer-ports.js";

import { getState, openMobileNewSession, openNewSession, requestNewSessionFocus, seedNewSession } from "../../../../core/client/src/integration/store.js";
import { navigateConsoleRoute } from "../../../../core/client/src/integration/console-location.js";
import { getViewModeSnapshot } from "../../../../core/client/src/integration/view-mode-store.js";
import { getViewedTheaterId } from "../../../../core/client/src/integration/viewed-theater.js";
import { readNewSessionSelection } from "./new-session-preferences.js";
import { getConversationSurface } from "./conversation-surface-store.js";
import { getConversationSubject } from "./conversation-slots.js";
import { mobileCommodoreTarget, readCommodoreList, readMobileCommodoreId, readZoneCommodore } from "../../../commodore/client/commodore-list.js";

/**
 * 새 세션이 처음 고르는 Theater — 후보는 그 사령관이 가진 Theater 목록뿐이다:
 * ① 마지막으로 고른 Theater, ② 지금 보고 있는 Theater, ③ 그 사령관 목록의 첫 Theater. 후보가 없으면 null —
 * 화면이 Theater 칩 자리에 「Theater 추가…」를 세운다. commodoreId 가 null 이면(사령관이 아직 없다) Console 에 등록된 Theater 에서 같은 순서로 고른다.
 */
export function resolveNewSessionTheaterId(commodoreId: string | null): string | null {
  const registered = new Set(getState().theaters.map((theater) => theater.id));
  const owned = commodoreId === null
    ? null
    : readCommodoreList().find((commodore) => commodore.commodoreId === commodoreId)?.theaters
      .filter((theater) => theater.status === "available" && registered.has(theater.theaterId))
      .map((theater) => theater.theaterId) ?? [];
  const ids = owned ?? [...registered];
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
 * 새 세션이 실을 사령관. 화면을 열 때 한 번 정해 고정하고, Theater 후보는 이 사령관의 목록이다.
 * ① 가운데 사령관 대화와 지금 보는 기록, ② 작전 구역·폰 칩, ③ 목록의 첫 사령관. 섹션 「+」는 제 사령관을 직접 싣는다.
 * 폰은 ②에서 홈 대화 목록 머리와 같은 사령관을 쓴다 — 칩에서 고른 사령관, 없으면 보고 있는 Theater 를 가진 사령관이다.
 * 사령관이 하나도 없으면 null — 호출부는 지금처럼 새 사령관을 만들도록 둔다.
 */
export function resolveNewSessionCommodoreId(): string | null {
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
  const picked = getViewModeSnapshot().effective === "mobile"
    ? readMobileCommodoreId() ?? mobileCommodoreTarget(getViewedTheaterId())
    : readZoneCommodore();
  return commodoreUuid(picked) ?? readCommodoreList()[0]?.commodoreId ?? null;
}

/** 지휘관 목록 「+」·사령관 메뉴 — 그 사령관을 실은 새 세션을 대화 칸에 연다. */
export function openCommodoreNewSession(commodoreId: string): void {
  openNewSession({ theaterId: resolveNewSessionTheaterId(commodoreId), commodoreId });
}

/**
 * 사이드바 맨 위 「+」·팔레트 「New Objective」·새 세션 단축키가 함께 쓰는 입구. 여는 것만으로는 아무것도 만들지 않는다.
 * 이미 열려 있으면 고른 Theater 를 그대로 두고 컴포저로 돌아간다 — 쓰던 문장과 고른 자리를 단축키가 갈아치우지 않는다.
 */
export function openDefaultNewSession(): void {
  if (getState().newSession !== null) {
    requestNewSessionFocus();
    return;
  }
  const commodoreId = resolveNewSessionCommodoreId();
  openNewSession({ theaterId: resolveNewSessionTheaterId(commodoreId), ...(commodoreId ? { commodoreId } : {}) });
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
