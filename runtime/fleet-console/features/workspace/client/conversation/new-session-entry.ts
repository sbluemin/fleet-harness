import { getState, openNewSession, requestNewSessionFocus } from "../../../../core/client/src/integration/store.js";
import { getViewedTheaterId } from "../../../../core/client/src/integration/viewed-theater.js";
import { readQuickLaunchSelection } from "../../../execution/client/quick-launch-preferences.js";

/**
 * 새 세션 화면이 처음 고르는 Theater — Quick Launch(⌘J)와 같은 규칙이다(quick-launch.tsx 의 `rememberedTheater ?? getViewedTheaterId()`):
 * ① 마지막으로 고른 Theater, ② 지금 보고 있는 Theater, ③ 목록 첫 Theater. 두 입구가 같은 기본값을 고르므로 ⌘J 시트와 새 세션 화면이
 * 서로 다른 Theater 를 미리 고르지 않는다. 등록된 Theater 가 없으면 null — 화면이 「Theater 추가…」를 먼저 세운다.
 */
export function resolveNewSessionTheaterId(): string | null {
  const ids = getState().theaters.map((theater) => theater.id);
  const remembered = readQuickLaunchSelection().theaterId;
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
