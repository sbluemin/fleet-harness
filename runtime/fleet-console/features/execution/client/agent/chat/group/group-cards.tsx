import type { ConversationDecision, ConversationHold, ConversationSpeaker, GroupConversationActions, GroupDecisionAnswer } from "@fleet-console/sdk/conversation";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { OperationUseRequest } from "../../../../../computer-use/client/computer-screen-share.js";
import { getT } from "../../i18n/index.js";
import { StreamedMarkdown } from "../../streamed-markdown.js";
import {
  formatUseRequestTime,
  UseRequestGlyph,
  useRequestSecondsLeft,
  useUseRequestAnswer,
  useUseRequestClock,
} from "../../use-request-card.js";
import { getGroupT } from "./group-chat-i18n.js";
import { SpeakerMark } from "./speaker-mark.js";

/**
 * 대화 안 카드 — 지휘관의 결정 요청과 Console·컴퓨터 사용 허용 요청.
 *
 * 어느 카드도 초점을 가져가지 않는다: 사람이 입력창에 치던 Enter 가 답이나 허용을 누르면 안 된다. 단추는 클릭이나 Tab 으로만
 * 닿고, 누르고 있는 Enter·Space 의 반복으로는 확정되지 않는다.
 *
 * 결정 카드의 글(질문·넘긴 이유·선택지 설명)은 대화 말풍선과 같은 마크다운 렌더(사이트 링크)로 그린다. 링크를 여는 길은 따로 두지
 * 않는다 — 말풍선의 앵커와 같은 자리에 서므로 그 표면의 링크 길(데스크톱 가운데 칸은 문서 링크 라우터, 폰 Operation 본문은 채팅 링크
 * 경계)이 그대로 연다. 앵커는 단추 안에 두지 않는다: 선택지 이름은 단추 안 평문이고, 설명은 단추 밖 같은 줄 안에 선다.
 */

/**
 * 결정 요청 카드 — 질문마다 선택지와 직접 답하기. 모든 질문에 답해야 보낸다. 보내는 길은 하나다: 계약의 `decision.answer`
 * 가 있으면 그것만, 없으면 `actions.answerDecision` 만 부른다. 실패하면 고른 것과 쓴 답을 지키고 사유 한 줄을 보인다.
 */
export function DecisionCard({ decision, actions, asker, language, phone = false, onAnswered }: {
  readonly decision: ConversationDecision;
  readonly actions: GroupConversationActions | null;
  readonly asker: ConversationSpeaker | null;
  readonly language: ConsoleLocale | undefined;
  /** 폰 그룹 대화 — 폰에는 보드가 없고 링크는 그 대화의 목표 탭으로 가므로 링크 이름을 바꾼다. */
  readonly phone?: boolean;
  /** 답이 받아들여졌다 — 답 자체는 보드가 결정으로 남긴 대화 줄(`decision-answer`)로 그 시각 자리에 선다. */
  readonly onAnswered: (decisionId: string) => void;
}) {
  const t = getGroupT(language);
  const [picks, setPicks] = React.useState<Readonly<Record<string, readonly string[]>>>({});
  const [texts, setTexts] = React.useState<Readonly<Record<string, string>>>({});
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [givingBack, setGivingBack] = React.useState(false);
  const [giveBackFailed, setGiveBackFailed] = React.useState(false);
  // 새 요청은 새 질문이다 — 앞 요청에 고르던 것을 옮겨 붙이지 않는다.
  React.useEffect(() => { setPicks({}); setTexts({}); setFailed(false); setGiveBackFailed(false); }, [decision.id]);
  const locale = language ?? "en";
  const text = (value: Parameters<typeof resolveLocalizedText>[0] | undefined) => (value === undefined ? "" : resolveLocalizedText(value, locale));
  const handed = decision.handed;
  const giveBack = handed?.giveBack;
  // 맡은 이에게 돌려주기 — 성공하면 보드가 넘김을 걷어 카드가 다시 그려진다. 실패는 한 줄로 말하고 카드를 그대로 둔다.
  const returnToHandler = async () => {
    if (!giveBack || givingBack || sending) return;
    setGivingBack(true);
    setGiveBackFailed(false);
    try { await giveBack.run(); } catch { setGiveBackFailed(true); } finally { setGivingBack(false); }
  };

  const answered = (questionId: string) => (picks[questionId]?.length ?? 0) > 0 || (texts[questionId] ?? "").trim().length > 0;
  const ready = decision.questions.every((question) => answered(question.id));
  const submitPath = decision.answer ?? (actions ? (answers: readonly GroupDecisionAnswer[]) => actions.answerDecision(decision.id, answers) : null);

  const toggle = (questionId: string, optionId: string, multi: boolean) => setPicks((current) => {
    const now = current[questionId] ?? [];
    const on = now.includes(optionId);
    return { ...current, [questionId]: multi ? (on ? now.filter((id) => id !== optionId) : [...now, optionId]) : (on ? [] : [optionId]) };
  });

  const submit = async () => {
    if (!submitPath || sending || !ready) return;
    const answers: GroupDecisionAnswer[] = decision.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: picks[question.id] ?? [],
      text: (texts[question.id] ?? "").trim(),
    }));
    setSending(true);
    setFailed(false);
    try {
      await submitPath(answers);
      onAnswered(decision.id);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const many = decision.questions.length > 1;
  const idBase = React.useId();
  return (
    <section className="group-card is-decision" aria-label={t("group.decision.badge")} onKeyDown={ignoreRepeat}>
      <div className="group-card-head">
        {asker ? <SpeakerMark speaker={asker} size="sm" /> : null}
        <span className="group-card-who">{asker ? `${asker.name} · ${t("group.decision.badge")}` : t("group.decision.badge")}</span>
        {decision.handler && !handed ? <span className="group-card-handler">{text(decision.handler)}</span> : null}
        <button type="button" className="group-chat-link" onClick={decision.open}>{t(phone ? "group.decision.openPhone" : "group.decision.open")}</button>
      </div>
      {handed ? (
        <div className="group-card-handed"><span className="group-card-handed-label">{text(handed.label)}</span><CardMarkdown text={handed.reason} language={locale} lead /></div>
      ) : null}
      {decision.questions.map((question, at) => (
        <div key={question.id} className="group-card-question">
          {question.header ? <span className="group-card-header">{question.header}</span> : null}
          <div className="group-card-title">{many ? `${at + 1}. ` : ""}<CardMarkdown text={question.text} language={locale} lead /></div>
          {question.options.map((option, optionAt) => {
            const on = (picks[question.id] ?? []).includes(option.id);
            const subId = `${idBase}-${question.id}-${option.id}`;
            // 줄 전체가 선택지다 — 단추(이름)의 클릭·Enter·Space 도 여기로 올라와 한 번 고른다. 설명 속 조작 요소(링크·코드 복사
            // 단추·펼침 머리 등)의 클릭은 고르지 않는다: 링크는 그대로 위로 흘려 링크 길이 열고, 나머지는 제 일만 한다.
            const onRow = (event: React.MouseEvent<HTMLDivElement>) => {
              if (sending) return;
              const control = (event.target as Element).closest(ROW_CONTROLS);
              if (control && control !== event.currentTarget && event.currentTarget.contains(control) && !control.classList.contains("group-card-choice-pick")) return;
              toggle(question.id, option.id, question.multiSelect);
            };
            return (
              <div key={option.id} className={`group-card-choice${on ? " is-on" : ""}${sending ? " is-disabled" : ""}`} onClick={onRow}>
                <button
                  type="button"
                  className="group-card-choice-pick"
                  aria-pressed={on}
                  aria-describedby={option.description ? subId : undefined}
                  disabled={sending}
                >
                  <span className="group-card-key" aria-hidden="true">{String.fromCharCode(65 + optionAt)}</span>
                  <span className="group-card-choice-text">{option.label}</span>
                </button>
                {option.description ? <div id={subId} className="group-card-choice-sub"><CardMarkdown text={option.description} language={locale} /></div> : null}
              </div>
            );
          })}
          <input
            className="group-card-own"
            type="text"
            value={texts[question.id] ?? ""}
            maxLength={decision.answerMaxLength}
            disabled={sending}
            placeholder={t("group.decision.own")}
            aria-label={t("group.decision.own")}
            onChange={(event) => setTexts((current) => ({ ...current, [question.id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.repeat) return;
              event.preventDefault();
              void submit();
            }}
          />
        </div>
      ))}
      <div className="group-card-foot">
        {failed ? <span className="group-card-error" role="alert">{t("group.decision.failed")}</span>
          : giveBackFailed ? <span className="group-card-error" role="alert">{t("group.decision.giveBackFailed")}</span>
          : decision.route ? <span className="group-card-route">{text(decision.route)}</span>
          : <span />}
        {giveBack ? (
          <button type="button" className="group-card-send is-quiet" disabled={givingBack || sending} onClick={() => { void returnToHandler(); }}>{text(giveBack.label)}</button>
        ) : null}
        <button type="button" className="group-card-send" disabled={!submitPath || !ready || sending || givingBack} onClick={() => { void submit(); }}>
          {sending ? t("group.decision.sending") : t("group.decision.send")}
        </button>
      </div>
    </section>
  );
}

/** 결정 요청 밖의 넘김 — 답하는 길은 늘 원래 입력창·보드에 두고 이유와 돌려주기만 이 카드가 진다. */
export function HoldCard({ hold, language }: { readonly hold: ConversationHold; readonly language: ConsoleLocale | undefined }) {
  const t = getGroupT(language);
  const locale = language ?? "en";
  const text = (value: Parameters<typeof resolveLocalizedText>[0]) => resolveLocalizedText(value, locale);
  const [givingBack, setGivingBack] = React.useState(false);
  const [giveBackFailed, setGiveBackFailed] = React.useState(false);
  React.useEffect(() => { setGiveBackFailed(false); }, [hold.id]);
  const giveBack = hold.handed.giveBack;
  const returnToHandler = async () => {
    if (!giveBack || givingBack) return;
    setGivingBack(true);
    setGiveBackFailed(false);
    try { await giveBack.run(); } catch { setGiveBackFailed(true); } finally { setGivingBack(false); }
  };
  return (
    <section className="group-card is-hold" aria-label={text(hold.title)} onKeyDown={ignoreRepeat}>
      <div className="group-card-head">
        <SpeakerMark speaker={{ kind: "commodore", name: t("group.commodore") }} size="sm" />
        <span className="group-card-who">{`${t("group.commodore")} · ${text(hold.title)}`}</span>
        {hold.reveal ? <button type="button" className="group-chat-link" onClick={hold.reveal.run}>{text(hold.reveal.label)}</button> : null}
      </div>
      <div className="group-card-handed"><span className="group-card-handed-label">{text(hold.handed.label)}</span><CardMarkdown text={hold.handed.reason} language={locale} lead /></div>
      <div className="group-card-foot">
        {giveBackFailed ? <span className="group-card-error" role="alert">{t("group.hold.giveBackFailed")}</span>
          : hold.route ? <span className="group-card-route">{text(hold.route)}</span> : <span />}
        {giveBack ? <button type="button" className="group-card-send is-quiet" disabled={givingBack} onClick={() => { void returnToHandler(); }}>{text(giveBack.label)}</button> : null}
      </div>
    </section>
  );
}

/**
 * 허용 요청 카드 — 기존 패널 카드와 같은 계약(답은 원래 요청한 Operation 으로, 거절 · 이번 작업만 · 계속 허용, 만료 시계,
 * 반복 키 무시, 초점 미이동)에 요청한 참여자의 표식과 이름만 더한다. 답 보내기는 기존 `useUseRequestAnswer` 가 진다.
 */
export function UseRequestGroupCard({ request, speaker, language }: {
  readonly request: OperationUseRequest;
  readonly speaker: ConversationSpeaker | null;
  readonly language: ConsoleLocale | undefined;
}) {
  const tt = getT(language ?? "en");
  const t = getGroupT(language);
  const { pending, failed, answer, onKeyDown } = useUseRequestAnswer(request, language);
  const now = useUseRequestClock(true);
  const left = useRequestSecondsLeft(request, now);
  const isConsole = request.capability === "console";
  const title = tt(isConsole ? "terminal.useRequest.consoleTitle" : "terminal.useRequest.computerTitle");
  const titleId = `group-use-request-${request.id}`;
  return (
    <div className="group-card is-use" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="group-card-head">
        {speaker ? <SpeakerMark speaker={speaker} size="sm" /> : <span className="group-card-glyph" aria-hidden="true"><UseRequestGlyph capability={request.capability} /></span>}
        <span className="group-card-who" id={titleId}>{speaker ? t("group.use.from", { name: speaker.name, title }) : title}</span>
        <span className={`group-card-timer${left <= 60 ? " is-soon" : ""}`} aria-hidden="true">{tt("terminal.useRequest.waiting", { time: formatUseRequestTime(left) })}</span>
      </div>
      <p className="group-card-lead">{tt(isConsole ? "terminal.useRequest.consoleLead" : "terminal.useRequest.computerLead")}</p>
      {request.tools.length > 0 ? <p className="group-card-tools">{request.tools.join(" · ")}</p> : null}
      <div className="group-card-foot">
        <button type="button" className="group-card-send is-quiet" disabled={pending} onClick={answer("deny")}>{tt("terminal.useRequest.deny")}</button>
        <span className="group-card-gap" />
        <button type="button" className="group-card-send is-quiet" disabled={pending} onClick={answer("always")}>{tt("terminal.useRequest.always")}</button>
        <button type="button" className="group-card-send" disabled={pending} onClick={answer("turn")}>{tt("terminal.useRequest.turn")}</button>
      </div>
      <p className="group-card-fine">{tt("terminal.useRequest.fine")}</p>
      {failed ? <p className="group-card-error" role="alert">{tt("terminal.useRequest.failed")}</p> : null}
    </div>
  );
}

/** 선택지 줄 안에서 제 일을 하는 조작 요소 — 이 안을 누른 클릭은 선택지를 고르지 않는다(고르는 단추 자신은 예외). */
const ROW_CONTROLS = "a, button, summary, input, select, textarea, label, [role=\"button\"], [role=\"link\"], [tabindex]";

/** 카드 안 글 — 말풍선의 마크다운 렌더(사이트 링크 포함)를 쓰고 글꼴·잉크는 카드 자리를 따른다. `lead` 는 앞 글자(번호·머리말)와 한 줄로 잇는다. */
function CardMarkdown({ text, language, lead = false }: { readonly text: string; readonly language: ConsoleLocale; readonly lead?: boolean }) {
  return <StreamedMarkdown text={text} streaming={false} className={`markdown-body group-card-md${lead ? " is-lead" : ""}`} language={language} siteLinks />;
}

/** 누르고 있는 Enter·Space 의 반복은 카드 안에서 멈춘다 — 두 번째 확정이 나가지 않는다. */
function ignoreRepeat(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}
