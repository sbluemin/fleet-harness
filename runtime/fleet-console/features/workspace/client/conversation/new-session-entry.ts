import type { MentionTargetAddress } from "../../../execution/shared/composer-ports.js";

import { getState, openMobileNewSession, openNewSession, requestNewSessionFocus, seedNewSession } from "../../../../core/client/src/integration/store.js";
import { navigateConsoleRoute } from "../../../../core/client/src/integration/console-location.js";
import { getViewModeSnapshot } from "../../../../core/client/src/integration/view-mode-store.js";
import { getViewedTheaterId } from "../../../../core/client/src/integration/viewed-theater.js";
import { readNewSessionSelection } from "./new-session-preferences.js";

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

/**
 * 사이드바 맨 위 「+」·팔레트 「New Operation」·새 세션 단축키가 함께 쓰는 입구. 여는 것만으로는 아무것도 만들지 않는다.
 * 이미 열려 있으면 고른 Theater 를 그대로 두고 컴포저로 돌아간다 — 쓰던 문장과 고른 자리를 단축키가 갈아치우지 않는다.
 */
export function openDefaultNewSession(): void {
  if (getState().newSession !== null) {
    requestNewSessionFocus();
    return;
  }
  openNewSession({ theaterId: resolveNewSessionTheaterId() });
}

/**
 * 플러그인·부유 위젯의 `composer.open` — 새 세션 컴포저를 열고 caret 을 넣는다. 폰에서는 새 대화 시트, 데스크톱에서는
 * 새 세션 화면이다(Operations 밖이면 그리로 옮긴다). `draft` 는 문면을 갈아치우고 보내지 않는다. 행선지는 '@'로 고른 것과 같다.
 */
export function openNewSessionComposer(options?: {
  readonly draft?: string;
  readonly mentionOperationId?: string;
  readonly mentionTarget?: MentionTargetAddress;
}): void {
  const draft = typeof options?.draft === "string" ? options.draft : null;
  const mentionOperationId = options?.mentionOperationId ?? null;
  const mentionTarget = options?.mentionTarget ?? null;
  if (draft !== null || mentionOperationId !== null || mentionTarget !== null) seedNewSession({ draft, mentionOperationId, mentionTarget });
  if (getViewModeSnapshot().effective === "mobile") {
    openMobileNewSession();
    return;
  }
  if (!getState().operationsViewActive) navigateConsoleRoute("/operations");
  openDefaultNewSession();
}
