/**
 * 우클릭 런치 메뉴가 여는 시작 표면 — 터미널이냐 채팅이냐.
 *
 * **Quick Launch의 `view`와 일부러 갈라 둔 값이다.** 두 입구는 같은 것을 실행하지만 서로 다른
 * 습관에 속한다: 컴포저는 문장을 먼저 쓰고 보내는 자리라 대화가 기본이 되기 쉽고, 메뉴는
 * 캔버스 위 좌표를 찍어 띄우는 자리다. 한쪽에서의 한 번이 다른 쪽 기본을 바꾸면, 사용자는
 * 자기가 건드리지 않은 문이 바뀐 것을 발사한 뒤에야 알게 된다. 그래서 기억은 둘이고,
 * 어긋남은 각 표면이 **자기 표식을 상시 세워** 갚는다(숨은 모드 금지).
 *
 * 값은 메뉴 하나에 하나다 — 모델 행마다 따로 두지 않는다. 행마다 다른 표면을 기억하면 같은
 * 메뉴 안에서 어떤 행은 터미널, 어떤 행은 채팅으로 열려 "이 메뉴를 누르면 무엇이 나오는가"를
 * 행 단위로 다시 확인해야 한다. 하나의 값이라 세 행의 표식이 함께 뒤집히고, 그 동시성이 곧
 * 계약의 설명이 된다.
 *
 * 서버 durable state가 아니라 localStorage인 이유는 `quick-launch-preferences.ts`와 같다 —
 * 이것은 이 브라우저의 습관이지 Console이 소유한 작전 상태가 아니다.
 */

import type { OperationLaunchView } from "@fleet-console/sdk/operations";

const STORAGE_KEY = "fleet-console.launchMenu.startSurface";

/** 기억이 없거나 읽을 수 없을 때의 표면. 기본은 기억이 아니라 계약이 정한다. */
export const DEFAULT_LAUNCH_START_SURFACE: OperationLaunchView = "terminal";

export function readLaunchStartSurface(): OperationLaunchView {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "chat" ? "chat" : DEFAULT_LAUNCH_START_SURFACE;
  } catch {
    // 스토리지 차단(사생활 보호 모드)은 "기억 없음"과 같은 상태다.
    return DEFAULT_LAUNCH_START_SURFACE;
  }
}

export function writeLaunchStartSurface(surface: OperationLaunchView): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, surface);
  } catch {
    // 기억에 실패해도 이번 실행 자체는 막지 않는다.
  }
}

/** 이 실행 종류가 채팅으로 태어날 수 있는가. 선언이 없으면 터미널뿐이라는 뜻이다. */
export function supportsChatStart(kind: { readonly launchViews?: readonly OperationLaunchView[] }): boolean {
  return kind.launchViews?.includes("chat") === true;
}

/**
 * 발사 변형에 시작 표면을 싣는다.
 *
 * 채팅일 때만, 그리고 그 종류가 채팅을 선언했을 때만 싣는다. 모르는 값을 실어 보내면 서버가
 * 409(`chat_unsupported`)로 되돌려 주는데, 그 왕복은 사용자가 고른 좌표를 잃는 길일 뿐이다 —
 * 여기서 터미널로 접는 편이 정직하다(플러그인 런치 어댑터가 같은 규율을 쓴다).
 */
export function withStartSurface(
  launch: Readonly<Record<string, string>> | undefined,
  kind: { readonly launchViews?: readonly OperationLaunchView[] },
  surface: OperationLaunchView,
): Readonly<Record<string, string>> | undefined {
  if (surface !== "chat" || !supportsChatStart(kind)) return launch;
  return { ...(launch ?? {}), viewMode: "chat" };
}
