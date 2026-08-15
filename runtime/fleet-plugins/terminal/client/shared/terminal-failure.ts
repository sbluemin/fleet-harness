import type { FailureNoticeProps } from "@fleet-console/sdk/components/failure-notice";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { TerminalMessageKey } from "../i18n/index.js";

/**
 * 서버가 티켓을 거절한 이유를 사람이 읽는 세 조각으로 옮긴다.
 *
 * 이 매핑은 터미널이 소유한다 — 이 코드들의 뜻을 아는 쪽이 여기이기 때문이다. SDK는 형태만
 * 고정하고 어떤 코드가 어떤 문장이 되는지는 알지 않는다.
 *
 * 연결 루프는 성공할 때까지 멈추지 않으므로, 원인이 해소되면 사용자가 아무것도 하지 않아도
 * 화면이 돌아온다. 그래서 대부분의 문장이 버튼 대신 "무엇을 하면 저절로 이어지는지"를 말한다.
 */
export function describeTerminalFailure(code: string | undefined, t: Translate<TerminalMessageKey>): FailureNoticeProps {
  const diagnostic = code;
  switch (code) {
    case "theater_id_required":
    case "theater_not_found":
      return {
        title: t("terminal.failure.theaterMissing.title"),
        cause: t("terminal.failure.theaterMissing.cause"),
        diagnostic,
        tone: "warn",
      };
    case "operation_id_required":
      return {
        title: t("terminal.failure.operationMissing.title"),
        cause: t("terminal.failure.operationMissing.cause"),
        diagnostic,
        tone: "warn",
      };
    case "operation_not_found":
    case "terminal_session_not_found":
      return {
        title: t("terminal.failure.sessionGone.title"),
        cause: t("terminal.failure.sessionGone.cause"),
        diagnostic,
        tone: "coral",
      };
    case "operation_dormant":
      return {
        title: t("terminal.failure.dormant.title"),
        cause: t("terminal.failure.dormant.cause"),
        diagnostic,
        tone: "warn",
      };
    case "invalid_shell_operation":
    case "invalid_global_shell_operation":
    case "operation_chat_mode":
      return {
        title: t("terminal.failure.wrongSurface.title"),
        cause: t("terminal.failure.wrongSurface.cause"),
        diagnostic,
        tone: "coral",
      };
    case "Unauthorized":
    case "unauthorized":
      return {
        title: t("terminal.failure.unauthorized.title"),
        cause: t("terminal.failure.unauthorized.cause"),
        diagnostic,
        tone: "coral",
      };
    default:
      return {
        title: t("terminal.failure.generic.title"),
        cause: t("terminal.failure.generic.cause"),
        diagnostic,
        tone: "warn",
      };
  }
}
