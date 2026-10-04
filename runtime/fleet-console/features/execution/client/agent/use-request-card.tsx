import { CaptionComputerUseGlyph, CaptionConsoleUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import { useOperationUseRequests, type OperationUseRequest } from "../../../computer-use/client/computer-screen-share.js";
import { answerUseRequest } from "./experiments-api.js";
import { getT } from "./i18n/index.js";

/**
 * 허용 요청 — 이 Operation 의 AI 가 허용받지 않은 콘솔 사용·컴퓨터 사용 도구를 부르면 서버가 그 호출을
 * 붙잡아 두고, 사람이 답할 때까지 기다린다. 답하는 자리는 Map 우하단 더미(use-request-corner.tsx)이고,
 * 패널 바닥에는 그 자리를 가리키는 한 줄 알림만 선다. 우하단이 없는 화면(Map 이 서지 않는 셸)에서는
 * 패널이 예전처럼 카드 전체를 보여 답을 받는다 — 요청이 답할 곳 없이 4분을 흘려보내면 안 된다.
 *
 * 어느 자리의 카드도 초점을 가져가지 않는다: 사람이 터미널이나 컴포저에 치던 Enter 가 허용을 누르면 안 된다.
 * 버튼은 클릭이나 Tab 으로만 닿고, 누르고 있는 키의 반복 입력으로는 확정되지 않는다.
 */

let cardApi: PluginInstallContext["api"] | null = null;
/** 실행 플러그인 설치 때 한 번 — 카드는 채팅 뷰 안에서도 그려지므로 install context 를 받지 못한다. */
export function setUseRequestApi(api: PluginInstallContext["api"] | null): void {
  cardApi = api;
}

export type UseRequestDecision = "deny" | "turn" | "always";

/** 한 요청의 답 보내기 — 보내는 동안의 두 번째 누름과 누르고 있는 Enter·Space 의 반복을 버린다. 패널·우하단이 같은 계약을 쓴다. */
export function useUseRequestAnswer(request: OperationUseRequest, language: ConsoleLocale | undefined) {
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const answer = (decision: UseRequestDecision) => () => {
    if (pending || !cardApi) return;
    setPending(true);
    setFailed(false);
    void answerUseRequest(cardApi, { operationId: request.operationId, requestId: request.id, capability: request.capability, decision, language: language === "ko" ? "ko" : "en" })
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

export function useRequestSecondsLeft(request: OperationUseRequest, now: number): number {
  return Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
}

export function formatUseRequestTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function UseRequestGlyph({ capability }: { readonly capability: OperationUseRequest["capability"] }) {
  return capability === "console" ? <CaptionConsoleUseGlyph /> : <CaptionComputerUseGlyph />;
}

/**
 * 우하단 더미의 상태 — 펼침(사람이 접을 때까지 유지), 펼친 카드, 패널 한 줄 알림이 보낸 「여기서 답하기」.
 * 패널 한 줄 알림은 우하단이 마운트돼 있을 때만 선다(없으면 패널이 카드 전체를 보인다).
 * 실행 기능은 코어와 같은 번들이라 이 모듈 상태 하나를 두 표면이 함께 읽는다.
 */
interface UseRequestCornerState {
  readonly expanded: boolean;
  /** 좁은 아레나에서 사람이 표시를 눌러 잠시 편 상태 — 새 요청은 이것을 켜지 않는다. */
  readonly compactOpen: boolean;
  readonly openId: string | null;
  /** 사람이 한 줄 알림을 눌러 그 요청 카드로 초점을 보내 달라고 한 요청. */
  readonly focusRequestId: string | null;
  readonly mounted: number;
}
let cornerState: UseRequestCornerState = { expanded: true, compactOpen: false, openId: null, focusRequestId: null, mounted: 0 };
const cornerListeners = new Set<() => void>();
export function setUseRequestCornerState(patch: Partial<UseRequestCornerState>): void {
  cornerState = { ...cornerState, ...patch };
  for (const listener of cornerListeners) listener();
}
function subscribeCorner(listener: () => void): () => void {
  cornerListeners.add(listener);
  return () => cornerListeners.delete(listener);
}
export function useUseRequestCornerState(): UseRequestCornerState {
  return React.useSyncExternalStore(subscribeCorner, () => cornerState);
}
/** 우하단 더미가 화면에 있는 동안 등록된다 — 패널은 이것으로 한 줄 알림과 카드 전체를 고른다. */
export function useUseRequestCornerRegistration(): void {
  React.useEffect(() => {
    setUseRequestCornerState({ mounted: cornerState.mounted + 1 });
    return () => setUseRequestCornerState({ mounted: Math.max(0, cornerState.mounted - 1) });
  }, []);
}

export function UseRequestCards({ operationId, childSessionIds, language, placement }: { readonly operationId: string; readonly childSessionIds?: readonly string[]; readonly language: ConsoleLocale | undefined; readonly placement: "chat" | "terminal" }) {
  const requests = useOperationUseRequests(operationId, childSessionIds);
  const corner = useUseRequestCornerState();
  const now = useUseRequestClock(requests.length > 0);
  if (requests.length === 0) return null;
  return (
    <div className={`use-request-stack is-${placement}`} data-keep-operation-active>
      {requests.map((request) => corner.mounted > 0
        ? <UseRequestStrip key={request.id} request={request} member={request.operationId !== operationId} language={language} now={now} />
        : <UseRequestCard key={request.id} request={request} language={language} now={now} />)}
    </div>
  );
}

/** 패널 바닥의 한 줄 알림 — 누르면 우하단 더미가 그 요청을 펴고 그 카드로 초점을 옮긴다(사람이 누른 이동). */
function UseRequestStrip({ request, member, language, now }: { readonly request: OperationUseRequest; readonly member: boolean; readonly language: ConsoleLocale | undefined; readonly now: number }) {
  const t = getT(language ?? "en");
  const left = useRequestSecondsLeft(request, now);
  const title = t(request.capability === "console" ? "terminal.useRequest.consoleTitle" : "terminal.useRequest.computerTitle");
  return (
    <button
      type="button"
      className="use-request-strip"
      onClick={() => setUseRequestCornerState({ expanded: true, compactOpen: true, openId: request.id, focusRequestId: request.id })}
    >
      <span className="use-request-glyph" aria-hidden="true"><UseRequestGlyph capability={request.capability} /></span>
      <span className="use-request-strip-title">{title}</span>
      {member ? <span className="use-request-strip-member">{t("terminal.useRequest.stripMember")}</span> : null}
      <span className="use-request-strip-lead">{t("terminal.useRequest.strip")}</span>
      <span className="use-request-strip-time">{formatUseRequestTime(left)}</span>
    </button>
  );
}

/** 우하단이 없는 화면에서 패널이 답을 받는 카드 전체. */
function UseRequestCard({ request, language, now }: { readonly request: OperationUseRequest; readonly language: ConsoleLocale | undefined; readonly now: number }) {
  const t = getT(language ?? "en");
  const { pending, failed, answer, onKeyDown } = useUseRequestAnswer(request, language);
  const left = useRequestSecondsLeft(request, now);
  const time = formatUseRequestTime(left);
  const isConsole = request.capability === "console";
  const titleId = `use-request-${request.id}`;

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
