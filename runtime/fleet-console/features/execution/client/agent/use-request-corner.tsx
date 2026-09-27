import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";
import { focusOperation } from "../../../../core/client/src/integration/store.js";
import { useAllOperationUseRequests, type OperationUseRequest } from "../../../computer-use/client/computer-screen-share.js";
import { getT } from "./i18n/index.js";
import {
  formatUseRequestTime,
  openUseRequestSettings,
  setUseRequestCornerState,
  useRequestSecondsLeft,
  UseRequestGlyph,
  useUseRequestAnswer,
  useUseRequestClock,
  useUseRequestCornerRegistration,
  useUseRequestCornerState,
} from "./use-request-card.js";

/** 요청이 누구의 것인지 — Map 이 아는 이름으로 캔버스가 풀어 준다. 구성원이면 지휘관(부모) 이름과 구성원 이름을 함께. */
export interface UseRequestSource {
  readonly operationTitle: string;
  readonly memberName: string | null;
}

const LATE_SECONDS = 60;
/** 서버가 요청을 붙잡아 두는 시간(use-requests.ts USE_REQUEST_HOLD_MS) — 시한 선의 전체 길이. */
const HOLD_SECONDS = 240;
const MAX_FOLDED_ROWS = 4;
const FRESH_MS = 1200;
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Map 우하단의 허용 요청 더미. 패널 밖에서도 요청을 알아채고 그 자리에서 답하게 한다.
 * 가장 최근 요청 한 장만 펴고, 나머지는 남은 시간이 짧은 순으로 한 줄씩 쌓는다. 「접기」는 더미를 같은 자리의
 * 대기 표시 하나로 줄이고, 접힌 채로 새 요청이 오면 고리만 한 번 퍼질 뿐 저절로 펴지지 않는다. 아레나가 더미를
 * 담지 못하는 좁은 화면(compact)에서는 늘 접힌 채로 서고, 사람이 표시를 누를 때만 잠시 편다.
 *
 * 도착은 초점을 옮기지 않는다 — 낭독은 상시 status 영역이 맡는다. 초점은 사람이 누를 때만 움직인다.
 */
export function UseRequestCorner({ language, compact, describeSource }: {
  readonly language: ConsoleLocale | undefined;
  readonly compact: boolean;
  readonly describeSource: (operationId: string) => UseRequestSource | null;
}) {
  useUseRequestCornerRegistration();
  const t = getT(language ?? "en");
  const requests = useAllOperationUseRequests();
  const corner = useUseRequestCornerState();
  const now = useUseRequestClock(requests.length > 0);
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(NO_IDS);
  const [announcement, setAnnouncement] = React.useState("");
  const seenRef = React.useRef<ReadonlySet<string>>(NO_IDS);
  const freshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipRef = React.useRef<HTMLButtonElement>(null);
  const foldRef = React.useRef<HTMLButtonElement>(null);
  const cardRefs = React.useRef(new Map<string, HTMLElement>());
  const pendingFocusRef = React.useRef<"chip" | "fold" | null>(null);

  // 오래 기다린 것부터(시한 순). 새 요청은 시한이 가장 늦다.
  const ordered = [...requests].sort((a, b) => a.expiresAt - b.expiresAt);
  const newest = ordered[ordered.length - 1] ?? null;
  const idsKey = ordered.map((request) => request.id).join("\n");

  React.useEffect(() => {
    const ids = idsKey ? idsKey.split("\n") : [];
    const incoming = ids.filter((id) => !seenRef.current.has(id));
    seenRef.current = new Set(ids);
    if (incoming.length === 0) return;
    const latestId = incoming[incoming.length - 1]!;
    // 새 요청이 펼친 카드 자리를 차지한다 — 펼침 여부는 건드리지 않는다(접힌 더미는 접힌 채로).
    setUseRequestCornerState({ openId: latestId });
    setFresh(new Set(incoming));
    if (freshTimerRef.current) clearTimeout(freshTimerRef.current);
    freshTimerRef.current = setTimeout(() => setFresh(NO_IDS), FRESH_MS);
    const request = ordered.find((item) => item.id === latestId);
    if (request) setAnnouncement(t("terminal.useRequest.corner.arrived", { title: titleOf(request, t), source: sourceLine(request, describeSource) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  React.useEffect(() => () => { if (freshTimerRef.current) clearTimeout(freshTimerRef.current); }, []);

  const expanded = compact ? corner.compactOpen : corner.expanded;
  const hasRequests = ordered.length > 0;

  React.useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (target === "chip") chipRef.current?.focus({ preventScroll: true });
    else if (target === "fold") foldRef.current?.focus({ preventScroll: true });
  });
  React.useEffect(() => {
    // 패널 한 줄 알림이 보낸 이동 — 사람이 누른 것이므로 그 카드로 초점을 옮긴다.
    const id = corner.focusRequestId;
    if (!id || !expanded) return;
    const card = cardRefs.current.get(id);
    if (!card) return;
    card.focus({ preventScroll: true });
    setUseRequestCornerState({ focusRequestId: null });
  }, [corner.focusRequestId, expanded, idsKey]);

  const fold = () => {
    pendingFocusRef.current = "chip";
    setUseRequestCornerState(compact ? { compactOpen: false } : { expanded: false });
  };
  const unfold = () => {
    pendingFocusRef.current = "fold";
    setUseRequestCornerState(compact ? { compactOpen: true } : { expanded: true });
  };

  // 누르고 있는 Enter·Space 의 반복은 더미 어디에서도 확정·토글이 되지 않는다 — 표시와 「접기」가 초점을 서로 넘겨주므로
  // 카드 밖 버튼까지 막지 않으면 누르고 있는 Enter 하나가 펼침·접힘을 되풀이한다.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  };
  const soonest = hasRequests ? Math.min(...ordered.map((request) => useRequestSecondsLeft(request, now))) : 0;
  const glyphOf = newest ?? ordered[0] ?? null;
  const open = hasRequests ? ordered.find((request) => request.id === corner.openId) ?? newest! : null;
  // 접힌 줄은 남은 시간이 짧은 것부터 — 가장 먼저 끝날 요청이 묻히지 않게.
  const rest = ordered.filter((request) => request !== open);
  const shown = rest.slice(0, MAX_FOLDED_ROWS);
  const hidden = rest.length - shown.length;
  const showStack = hasRequests && expanded;

  const openFresh = open ? fresh.has(open.id) : false;

  // 루트와 낭독 영역은 빈 상태·접힘·펼침 어디서나 같은 자리에 머문다 — 다시 마운트되는 live region 은 토글 직후의 도착을 놓친다.
  return (
    <div
      className={`use-corner${!hasRequests ? " is-empty" : expanded ? "" : " is-folded"}`}
      role={showStack ? "region" : undefined}
      aria-label={showStack ? t("terminal.useRequest.corner.region") : undefined}
      data-canvas-blocker
      data-keep-operation-active
      onKeyDown={onKeyDown}
    >
      <span className="use-corner-live" role="status" aria-live="polite">{announcement}</span>
      {hasRequests && !expanded && glyphOf ? (
        <button
          ref={chipRef}
          type="button"
          className={`use-corner-chip${fresh.size > 0 ? " is-fresh" : ""}${soonest <= LATE_SECONDS ? " is-late" : ""}`}
          aria-expanded="false"
          aria-label={t("terminal.useRequest.corner.show", { count: ordered.length })}
          onClick={unfold}
        >
          <UseRequestRing capability={glyphOf.capability} seconds={soonest} size="sm" />
          <span className="use-corner-chip-label">{t("terminal.useRequest.corner.chip")}</span>
          {ordered.length > 1 ? <span className="use-corner-count">{ordered.length}</span> : null}
          <span className="use-corner-time">{formatUseRequestTime(soonest)}</span>
        </button>
      ) : null}
      {showStack && open ? (
        <div className={`use-corner-panel${openFresh ? " is-fresh" : ""}${soonest <= LATE_SECONDS ? " is-late" : ""}`}>
          <div className="use-corner-head">
            <span className="use-corner-caption">{t("terminal.useRequest.corner.chip")}</span>
            {ordered.length > 1 ? <span className="use-corner-count">{ordered.length}</span> : null}
            {rest.length > 0 ? <span className="use-corner-order">{t("terminal.useRequest.corner.bySoonest")}</span> : null}
            <button
              ref={foldRef}
              type="button"
              className="use-corner-fold"
              aria-expanded="true"
              aria-label={t("terminal.useRequest.corner.fold")}
              title={t("terminal.useRequest.corner.fold")}
              onClick={fold}
            >
              <FoldGlyph />
            </button>
          </div>
          {shown.length > 0 ? (
            <div className="use-corner-rows">
              {shown.map((request) => {
                const left = useRequestSecondsLeft(request, now);
                const source = describeSource(request.operationId);
                return (
                  <button
                    key={request.id}
                    type="button"
                    className={`use-corner-row${fresh.has(request.id) ? " is-fresh" : ""}${left <= LATE_SECONDS ? " is-late" : ""}`}
                    onClick={() => setUseRequestCornerState({ openId: request.id })}
                  >
                    <span className="use-corner-glyph" aria-hidden="true"><UseRequestGlyph capability={request.capability} /></span>
                    <span className="use-corner-row-label">
                      {titleOf(request, t)}
                      <span className="use-corner-row-source">{source?.memberName ?? source?.operationTitle ?? ""}</span>
                    </span>
                    <span className="use-corner-time">{formatUseRequestTime(left)}</span>
                  </button>
                );
              })}
              {hidden > 0 ? <span className="use-corner-more">{t("terminal.useRequest.corner.more", { count: hidden })}</span> : null}
            </div>
          ) : null}
          <UseRequestCornerCard
            key={open.id}
            request={open}
            source={describeSource(open.operationId)}
            now={now}
            language={language}
            cardRef={(element) => {
              if (element) cardRefs.current.set(open.id, element);
              else cardRefs.current.delete(open.id);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function UseRequestCornerCard({ request, source, now, language, cardRef }: {
  readonly request: OperationUseRequest;
  readonly source: UseRequestSource | null;
  readonly now: number;
  readonly language: ConsoleLocale | undefined;
  readonly cardRef: (element: HTMLElement | null) => void;
}) {
  const t = getT(language ?? "en");
  const { pending, failed, answer, onKeyDown } = useUseRequestAnswer(request, language);
  const left = useRequestSecondsLeft(request, now);
  const isConsole = request.capability === "console";
  const blocked = request.blocked === "experiment_disabled";
  const titleId = `use-corner-${request.id}`;
  const sourceName = source?.memberName ?? source?.operationTitle ?? "";
  return (
    <div
      ref={cardRef}
      className={`use-corner-card${left <= LATE_SECONDS ? " is-late" : ""}`}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="use-corner-card-head">
        <UseRequestRing capability={request.capability} seconds={left} size="lg" />
        <span className="use-corner-titles">
          <span className="use-corner-title" id={titleId}>{t(isConsole ? "terminal.useRequest.consoleTitle" : "terminal.useRequest.computerTitle")}</span>
          {/* 요청한 Operation 이름이 곧 그 패널로 가는 길이다 — 따로 「패널로 이동」 줄을 두지 않는다. */}
          <button
            type="button"
            className="use-corner-source"
            aria-label={t("terminal.useRequest.corner.goTo", { name: sourceName })}
            title={t("terminal.useRequest.corner.goTo", { name: sourceName })}
            onClick={() => focusOperation(request.operationId)}
          >
            {source?.memberName ? <span className="use-corner-source-parent">{source.operationTitle} ›</span> : null}
            <span className="use-corner-source-name">{sourceName}</span>
            <GoGlyph />
          </button>
        </span>
        <span className="use-corner-time" aria-label={t("terminal.useRequest.corner.left", { time: formatUseRequestTime(left) })}>{formatUseRequestTime(left)}</span>
      </div>
      {blocked ? <p className="use-corner-lead">{t("terminal.useRequest.blocked")}</p> : null}
      {!blocked && request.tools.length > 0 ? (
        <ul className="use-corner-tools" aria-label={t("terminal.useRequest.corner.tools")}>
          {request.tools.map((tool) => <li key={tool}>{tool}</li>)}
        </ul>
      ) : null}
      {blocked ? (
        <div className="use-corner-actions">
          <button type="button" className="use-corner-button is-plain" disabled={pending} onClick={answer("deny")}>{t("terminal.useRequest.deny")}</button>
          <span className="use-request-gap" />
          <button type="button" className="use-corner-button is-primary" onClick={openUseRequestSettings}>{t("terminal.useRequest.openSettings")}</button>
        </div>
      ) : (
        <>
          <div className="use-corner-actions">
            <button type="button" className="use-corner-button is-plain" disabled={pending} onClick={answer("deny")}>{t("terminal.useRequest.deny")}</button>
            <span className="use-request-gap" />
            <button type="button" className="use-corner-button is-quiet" disabled={pending} onClick={answer("always")}>{t("terminal.useRequest.always")}</button>
            <button type="button" className="use-corner-button is-primary" disabled={pending} onClick={answer("turn")}>{t("terminal.useRequest.turn")}</button>
          </div>
          <p className="use-corner-fine">{t("terminal.useRequest.corner.fine")}</p>
        </>
      )}
      {failed ? <p className="use-request-error" role="alert">{t("terminal.useRequest.failed")}</p> : null}
    </div>
  );
}

/**
 * 남은 시간 고리 — 글리프를 두른 원이 4분 시한만큼 줄어든다. 줄어드는 호가 곧 남은 시간이고, 1분 이하에서는
 * 호가 aurora 로 짙어진다. 대기 점멸은 고리 바탕의 느린 숨으로 말한다.
 */
function UseRequestRing({ capability, seconds, size }: { readonly capability: OperationUseRequest["capability"]; readonly seconds: number; readonly size: "sm" | "lg" }) {
  const remaining = Math.max(0, Math.min(100, (seconds / HOLD_SECONDS) * 100));
  return (
    <span className={`use-corner-ring is-${size}`} aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <circle className="use-corner-ring-track" cx="18" cy="18" r="16.5" pathLength={100} />
        <circle className="use-corner-ring-arc" cx="18" cy="18" r="16.5" pathLength={100} strokeDasharray={`${remaining} 100`} />
      </svg>
      <span className="use-corner-ring-glyph"><UseRequestGlyph capability={capability} /></span>
    </span>
  );
}

function FoldGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GoGlyph() {
  return (
    <svg className="use-corner-source-go" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 10.5 10.5 5.5M6.5 5.5h4v4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function titleOf(request: OperationUseRequest, t: ReturnType<typeof getT>): string {
  return t(request.capability === "console" ? "terminal.useRequest.consoleTitle" : "terminal.useRequest.computerTitle");
}

function sourceLine(request: OperationUseRequest, describeSource: (operationId: string) => UseRequestSource | null): string {
  const source = describeSource(request.operationId);
  if (!source) return "";
  return source.memberName ? `${source.operationTitle} › ${source.memberName}` : source.operationTitle;
}
