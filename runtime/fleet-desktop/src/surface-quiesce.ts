import type { WebContents } from "electron";

import type { SwitchAttempt } from "./console-surface-state.js";

/**
 * 로컬 화면을 떠나기 전의 확인. 화면 공유와 미리보기 트랙은 로컬 뷰를 뒤로 세워 두는 것만으로는 멈추지 않는다
 * (뷰는 살아 있고 정리 코드는 돌지 않는다). 그래서 떠나기 전에 그 뷰에게 멈추라고 알리고, 멈췄다는 답을 받은
 * 뒤에만 떠난다.
 *
 * 알림은 공개 desktop 프로토콜(`PUT /api/v1/desktop/shell`의 `surface`)로 로컬 Console에 보내고, Console은
 * 그 창의 스트림으로 화면에 전한다. 답은 그 화면이 자기 제목에 단다. 셸은 **그 로컬 뷰의 렌더러**에서 제목을
 * 읽으므로, 같은 콘솔을 연 다른 탭이 대신 답할 수 없다. 답에는 이번 전환의 세대가 실리고, 옛 세대의 답은 버린다.
 */

/**
 * 답의 표식. Console의 core/client/src/integration/desktop-shell.ts가 같은 이름으로 선언한다(Console 내부를
 * import하지 않는 규칙 — 준비 표식과 같은 방식). 한쪽만 고치면 답이 닿지 않아 모든 전환이 취소된다.
 */
export const DESKTOP_LEAVING_ACK_MARK = "⁤";
/** 답을 기다리는 시간. 이 안에 답이 없으면 떠나지 않는다. */
export const LEAVING_ACK_TIMEOUT_MS = 3_000;

const LEAVING_ACK = new RegExp(`${DESKTOP_LEAVING_ACK_MARK}(\\d+)${DESKTOP_LEAVING_ACK_MARK}`, "u");

export interface SurfaceQuiesceDeps {
  /** 떠나려는 로컬 뷰. 답은 이 렌더러에서만 읽는다. */
  readonly localContents: () => Pick<WebContents, "on" | "removeListener" | "isDestroyed"> | null;
  /** 로컬 Console에 떠남을 알린다. 받아들여지지 않으면 false. */
  readonly announce: (generation: number) => Promise<boolean>;
  /** 아직 답하지 않은 캡처 요청을 끝낸다 — 떠난 뒤에 트랙이 생기지 않게. */
  readonly abortPendingCapture: (reason: string) => void;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export function createSurfaceQuiesce(deps: SurfaceQuiesceDeps): (attempt: SwitchAttempt) => Promise<void> {
  return async (attempt) => {
    deps.abortPendingCapture("leaving local");
    const contents = deps.localContents();
    if (!contents || contents.isDestroyed()) throw new Error("surface_leave_unacknowledged");
    let settle: (acknowledged: boolean) => void = () => undefined;
    const answered = new Promise<boolean>((resolve) => { settle = resolve; });
    const onTitle = (_event: unknown, title: string): void => {
      const match = LEAVING_ACK.exec(title);
      if (match && Number(match[1]) === attempt.generation) settle(true);
    };
    // 알리기 전에 듣는다 — 답이 알림보다 먼저 올 수는 없지만, 알림의 응답보다 먼저 올 수는 있다.
    contents.on("page-title-updated", onTitle as never);
    const timer = setTimeout(() => settle(false), deps.timeoutMs ?? LEAVING_ACK_TIMEOUT_MS);
    try {
      if (!(await deps.announce(attempt.generation))) throw new Error("surface_leave_unacknowledged");
      if (!(await answered)) {
        deps.log?.(`surface leave not acknowledged generation=${attempt.generation}`);
        throw new Error("surface_leave_unacknowledged");
      }
      if (!attempt.isCurrent()) throw new Error("surface_switch_superseded");
    } finally {
      clearTimeout(timer);
      contents.removeListener("page-title-updated", onTitle as never);
    }
  };
}
