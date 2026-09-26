import { CaptionComputerUseGlyph, CaptionConsoleUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import { openPane } from "../../../../core/client/src/chrome/pane/pane-store.js";
import { openRailPanel } from "../../../../core/client/src/chrome/rail/rail-store.js";
import { useOperationUseRequests, type OperationUseRequest } from "../../../computer-use/client/computer-screen-share.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../../../settings/client/settings-entry.js";
import { answerUseRequest } from "./experiments-api.js";
import { getT } from "./i18n/index.js";

/**
 * 패널 안 허용 요청 카드 — 이 Operation 의 AI 가 허용받지 않은 콘솔 사용·컴퓨터 사용 도구를 부르면 서버가 그 호출을
 * 붙잡아 두고, 이 카드가 사람의 답을 받는다. 채팅은 대화 면 바닥(컴포저 바로 위), 터미널은 본문 바닥에 선다.
 *
 * 카드는 초점을 가져가지 않는다: 사람이 터미널이나 컴포저에 치던 Enter 가 허용을 누르면 안 된다. 버튼은 클릭이나
 * Tab 으로만 닿고, 누르고 있는 키의 반복 입력으로는 확정되지 않는다.
 */

let cardApi: PluginInstallContext["api"] | null = null;
/** 실행 플러그인 설치 때 한 번 — 카드는 채팅 뷰 안에서도 그려지므로 install context 를 받지 못한다. */
export function setUseRequestApi(api: PluginInstallContext["api"] | null): void {
  cardApi = api;
}

export function UseRequestCards({ operationId, language, placement }: { readonly operationId: string; readonly language: ConsoleLocale | undefined; readonly placement: "chat" | "terminal" }) {
  const requests = useOperationUseRequests(operationId);
  if (requests.length === 0) return null;
  return (
    <div className={`use-request-stack is-${placement}`} data-keep-operation-active>
      {requests.map((request) => <UseRequestCard key={request.id} request={request} language={language} />)}
    </div>
  );
}

function UseRequestCard({ request, language }: { readonly request: OperationUseRequest; readonly language: ConsoleLocale | undefined }) {
  const t = getT(language ?? "en");
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const isConsole = request.capability === "console";
  const titleId = `use-request-${request.id}`;

  const answer = (decision: "deny" | "turn" | "always") => () => {
    // 보내는 동안의 두 번째 누름은 버린다. 누르고 있는 Enter 의 반복은 아래 onKeyDown 이 막는다.
    if (pending || !cardApi) return;
    setPending(true);
    setFailed(false);
    void answerUseRequest(cardApi, { operationId: request.operationId, requestId: request.id, capability: request.capability, decision, language: language === "ko" ? "ko" : "en" })
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // 반복 입력은 카드 안에서 멈춘다 — Enter·Space 를 누르고 있어도 두 번째 확정이 나가지 않는다.
    if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  };
  const openSettings = () => {
    openRailPanel(SETTINGS_RAIL_ENTRY_ID);
    openPane({ paneId: SETTINGS_PANE_ID, params: { section: "experiments" } });
  };

  return (
    <div className="use-request-card" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="use-request-head">
        <span className="use-request-glyph" aria-hidden="true">{isConsole ? <CaptionConsoleUseGlyph /> : <CaptionComputerUseGlyph />}</span>
        <span className="use-request-title" id={titleId}>{t(isConsole ? "terminal.useRequest.consoleTitle" : "terminal.useRequest.computerTitle")}</span>
        <span className="use-request-timer" aria-hidden="true">{t("terminal.useRequest.waiting", { time })}</span>
      </div>
      <p className="use-request-lead">{t(isConsole ? "terminal.useRequest.consoleLead" : "terminal.useRequest.computerLead")}</p>
      {request.tools.length > 0 ? <p className="use-request-tools">{request.tools.join(" · ")}</p> : null}
      {request.blocked === "experiment_disabled" ? (
        <div className="use-request-foot">
          <button type="button" className="agent-chat-ask-send is-quiet" disabled={pending} onClick={answer("deny")}>{t("terminal.useRequest.deny")}</button>
          <span className="use-request-blocked">{t("terminal.useRequest.blocked")}</span>
          <button type="button" className="agent-chat-ask-send" onClick={openSettings}>{t("terminal.useRequest.openSettings")}</button>
        </div>
      ) : (
        <>
          <div className="use-request-foot">
            <button type="button" className="agent-chat-ask-send is-quiet" disabled={pending} onClick={answer("deny")}>{t("terminal.useRequest.deny")}</button>
            <span className="use-request-gap" />
            <button type="button" className="agent-chat-ask-send is-quiet" disabled={pending} onClick={answer("always")}>{t("terminal.useRequest.always")}</button>
            <button type="button" className="agent-chat-ask-send" disabled={pending} onClick={answer("turn")}>{t("terminal.useRequest.turn")}</button>
          </div>
          <p className="use-request-fine">{t("terminal.useRequest.fine")}</p>
        </>
      )}
      {failed ? <p className="use-request-error" role="alert">{t("terminal.useRequest.failed")}</p> : null}
    </div>
  );
}
