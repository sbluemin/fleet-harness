import type { ExecutionClientDeps } from "../deps.js";
import { CaptionComputerUseGlyph, CaptionConsoleUseGlyph } from "../../../workspace/client/components/caption-actions.js";
import type { ConsoleLocale } from "@fleet-console/i18n";
import * as React from "react";
import { useObjectiveUseRequests, type ObjectiveUseRequest } from "../../../computer-use/client/computer-screen-share.js";
import { answerUseRequest } from "./experiments-api.js";
import { getT } from "./i18n/index.js";
import { MobileGlyph, useMobileSurface } from "./mobile-surface.js";
import { showMobileToast } from "../../../../core/client/src/chrome/mobile/mobile-toast.js";
import { getViewModeSnapshot } from "../../../../core/client/src/integration/view-mode-store.js";

/**
 * 허용 요청 — 이 Objective 의 AI 가 허용받지 않은 콘솔 사용·컴퓨터 사용 도구를 부르면 서버가 그 호출을
 * 붙잡아 두고, 사람이 답할 때까지 기다린다. 채팅·터미널 패널의 요청 카드에서 허용 범위를 고른다 —
 * 요청이 답할 곳 없이 4분을 흘려보내면 안 된다.
 *
 * 어느 자리의 카드도 초점을 가져가지 않는다: 사람이 터미널이나 컴포저에 치던 Enter 가 허용을 누르면 안 된다.
 * 버튼은 클릭이나 Tab 으로만 닿고, 누르고 있는 키의 반복 입력으로는 확정되지 않는다.
 */

let cardApi: ExecutionClientDeps["api"] | null = null;
/** 실행 플러그인 설치 때 한 번 — 카드는 채팅 뷰 안에서도 그려지므로 install context 를 받지 못한다. */
export function setUseRequestApi(api: ExecutionClientDeps["api"] | null): void {
  cardApi = api;
}

export type UseRequestDecision = "deny" | "turn" | "always";

/** 모바일에서는 답한 뒤 토스트로 알린다(S-33: 거절 · 계속 허용 · 이번 작업만 허용). */
function announceMobileAnswer(decision: UseRequestDecision, capability: "console" | "computer"): void {
  if (getViewModeSnapshot().effective !== "mobile") return;
  const t = getT(document.documentElement.lang === "ko" ? "ko" : "en");
  showMobileToast(t(decision === "deny" ? "terminal.mobile.toastDeny" : decision === "turn" ? "terminal.mobile.toastTurn" : capability === "console" ? "terminal.mobile.toastAlwaysConsole" : "terminal.mobile.toastAlwaysComputer"));
}

/** 한 요청의 답 보내기 — 보내는 동안의 두 번째 누름과 누르고 있는 Enter·Space 의 반복을 버린다. 채팅·터미널이 같은 계약을 쓴다. */
export function useUseRequestAnswer(request: ObjectiveUseRequest, language: ConsoleLocale | undefined) {
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const answer = (decision: UseRequestDecision) => () => {
    if (pending || !cardApi) return;
    setPending(true);
    setFailed(false);
    void answerUseRequest(cardApi, { objectiveId: request.objectiveId, requestId: request.id, capability: request.capability, decision, language: language === "ko" ? "ko" : "en" })
      .then(() => { announceMobileAnswer(decision, request.capability); })
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // 반복 입력은 카드 안에서 멈춘다 — Enter·Space 를 누르고 있어도 두 번째 확정이 나가지 않는다.
    if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  };
  return { pending, failed, answer, onKeyDown };
}

/** 남은 시간(초)을 1초마다 다시 센다. */
export function useUseRequestClock(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function requestSecondsLeft(request: ObjectiveUseRequest, now: number): number {
  return Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
}

export function formatUseRequestTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function UseRequestGlyph({ capability }: { readonly capability: ObjectiveUseRequest["capability"] }) {
  return capability === "console" ? <CaptionConsoleUseGlyph /> : <CaptionComputerUseGlyph />;
}

export function UseRequestCards({ objectiveId, childSessionIds, language, placement }: { readonly objectiveId: string; readonly childSessionIds?: readonly string[]; readonly language: ConsoleLocale | undefined; readonly placement: "chat" | "terminal" }) {
  const requests = useObjectiveUseRequests(objectiveId, childSessionIds);
  const now = useUseRequestClock(requests.length > 0);
  if (requests.length === 0) return null;
  return (
    <div className={`use-request-stack is-${placement}`} data-keep-objective-active>
      {requests.map((request) => <UseRequestCard key={request.id} request={request} member={request.objectiveId !== objectiveId} language={language} now={now} />)}
    </div>
  );
}

/** 패널에서 허용 범위를 고르는 요청 카드. */
function UseRequestCard({ request, member, language, now }: { readonly request: ObjectiveUseRequest; readonly member: boolean; readonly language: ConsoleLocale | undefined; readonly now: number }) {
  const t = getT(language ?? "en");
  const { pending, failed, answer, onKeyDown } = useUseRequestAnswer(request, language);
  const left = requestSecondsLeft(request, now);
  const time = formatUseRequestTime(left);
  const isConsole = request.capability === "console";
  const titleId = `use-request-${request.id}`;
  const mobile = useMobileSurface();
  const [fineOpen, setFineOpen] = React.useState(false);

  if (mobile) {
    // 모바일 카드(impl-spec S-28·D25) — 입력창 바로 위. 머리는 대기 상태 글리프, 남은 시간이 1분 이하면 대기
    // 신호색으로 선다. 허용 범위 안내는 접혀 있다가 누르면 그 자리에 펼친다. 입력은 막지 않는다(D24).
    return (
      <div className="use-request-card is-mobile" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div className="use-request-head">
          <span className="agent-status-glyph is-awaiting" aria-hidden="true" />
          <span className="use-request-title" id={titleId}>{t(isConsole ? "terminal.useRequest.consoleTitle" : "terminal.useRequest.computerTitle")}</span>
          {member ? <span className="use-request-member">{t("terminal.useRequest.stripMember")}</span> : null}
          <span className={`use-request-timer${left <= 60 ? " is-soon" : ""}`} aria-hidden="true">{t("terminal.useRequest.waiting", { time })}</span>
        </div>
        <p className="use-request-lead">{t(isConsole ? "terminal.useRequest.consoleLead" : "terminal.useRequest.computerLead")}</p>
        {request.tools.length > 0 ? <p className="use-request-tools">{request.tools.join(" · ")}</p> : null}
        <div className="use-request-foot">
          <button type="button" className="use-request-pill" disabled={pending} onClick={answer("deny")}>{t("terminal.useRequest.deny")}</button>
          <span className="use-request-gap" />
          <button type="button" className="use-request-pill" disabled={pending} onClick={answer("always")}>{t("terminal.useRequest.always")}</button>
          <button type="button" className="use-request-pill is-primary" disabled={pending} onClick={answer("turn")}>{t("terminal.useRequest.turn")}</button>
        </div>
        <button type="button" className="use-request-scope" aria-expanded={fineOpen} onClick={() => setFineOpen((open) => !open)}>
          <MobileGlyph name="info" size={14} />
          {t("terminal.mobile.useRequestScope")}
        </button>
        {fineOpen ? <p className="use-request-fine">{t("terminal.useRequest.fine")}</p> : null}
        {failed ? <p className="use-request-error" role="alert">{t("terminal.useRequest.failed")}</p> : null}
      </div>
    );
  }

  return (
    <div className="use-request-card" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="use-request-head">
        <span className="use-request-glyph" aria-hidden="true"><UseRequestGlyph capability={request.capability} /></span>
        <span className="use-request-title" id={titleId}>{t(isConsole ? "terminal.useRequest.consoleTitle" : "terminal.useRequest.computerTitle")}</span>
        <span className="use-request-timer" aria-hidden="true">{t("terminal.useRequest.waiting", { time })}</span>
      </div>
      <p className="use-request-lead">{t(isConsole ? "terminal.useRequest.consoleLead" : "terminal.useRequest.computerLead")}</p>
      {request.tools.length > 0 ? <p className="use-request-tools">{request.tools.join(" · ")}</p> : null}
      <div className="use-request-foot">
        <button type="button" className="agent-chat-ask-send is-quiet" disabled={pending} onClick={answer("deny")}>{t("terminal.useRequest.deny")}</button>
        <span className="use-request-gap" />
        <button type="button" className="agent-chat-ask-send is-quiet" disabled={pending} onClick={answer("always")}>{t("terminal.useRequest.always")}</button>
        <button type="button" className="agent-chat-ask-send" disabled={pending} onClick={answer("turn")}>{t("terminal.useRequest.turn")}</button>
      </div>
      <p className="use-request-fine">{t("terminal.useRequest.fine")}</p>
      {failed ? <p className="use-request-error" role="alert">{t("terminal.useRequest.failed")}</p> : null}
    </div>
  );
}
