import type { ConversationDecision, ConversationSpeaker, GroupConversationActions, GroupDecisionAnswer } from "@fleet-console/sdk/conversation";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { OperationUseRequest } from "../../../../../computer-use/client/computer-screen-share.js";
import { getT } from "../../i18n/index.js";
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
 */

/** 답한 결정 한 줄 — 보드에서 요청이 걷혀도 대화에는 무엇을 골랐는지 남는다(이 화면을 보는 동안). */
export interface SettledDecision {
  readonly id: string;
  readonly title: string;
  readonly answer: string;
}

/**
 * 결정 요청 카드 — 질문마다 선택지와 직접 답하기. 모든 질문에 답해야 보낸다. 보내는 길은 하나다: 계약의 `decision.answer`
 * 가 있으면 그것만, 없으면 `actions.answerDecision` 만 부른다. 실패하면 고른 것과 쓴 답을 지키고 사유 한 줄을 보인다.
 */
export function DecisionCard({ decision, actions, asker, language, onSettled }: {
  readonly decision: ConversationDecision;
  readonly actions: GroupConversationActions | null;
  readonly asker: ConversationSpeaker | null;
  readonly language: ConsoleLocale | undefined;
  readonly onSettled: (settled: SettledDecision) => void;
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
      const summary = decision.questions.map((question) => {
        const labels = question.options.filter((option) => (picks[question.id] ?? []).includes(option.id)).map((option) => option.label);
        const own = (texts[question.id] ?? "").trim();
        return [...labels, ...(own ? [own] : [])].join(", ");
      }).join(" · ");
      onSettled({ id: decision.id, title: decision.title, answer: summary });
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const many = decision.questions.length > 1;
  return (
    <section className="group-card is-decision" aria-label={t("group.decision.badge")} onKeyDown={ignoreRepeat}>
      <div className="group-card-head">
        {asker ? <SpeakerMark speaker={asker} size="sm" /> : null}
        <span className="group-card-who">{asker ? `${asker.name} · ${t("group.decision.badge")}` : t("group.decision.badge")}</span>
        {decision.handler && !handed ? <span className="group-card-handler">{text(decision.handler)}</span> : null}
        <button type="button" className="group-chat-link" onClick={decision.open}>{t("group.decision.open")}</button>
      </div>
      {handed ? (
        <p className="group-card-handed"><span className="group-card-handed-label">{text(handed.label)}</span>{handed.reason}</p>
      ) : null}
      {decision.questions.map((question, at) => (
        <div key={question.id} className="group-card-question">
          <p className="group-card-title">{many ? `${at + 1}. ` : ""}{question.text}</p>
          {question.options.map((option, optionAt) => {
            const on = (picks[question.id] ?? []).includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                className={`group-card-choice${on ? " is-on" : ""}`}
                aria-pressed={on}
                disabled={sending}
                onClick={() => toggle(question.id, option.id, question.multiSelect)}
              >
                <span className="group-card-key" aria-hidden="true">{String.fromCharCode(65 + optionAt)}</span>
                <span className="group-card-choice-text">
                  <span>{option.label}</span>
                  {option.description ? <span className="group-card-choice-sub">{option.description}</span> : null}
                </span>
              </button>
            );
          })}
          <input
            className="group-card-own"
            type="text"
            value={texts[question.id] ?? ""}
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

export function SettledDecisionLine({ settled, language }: { readonly settled: SettledDecision; readonly language: ConsoleLocale | undefined }) {
  const t = getGroupT(language);
  return (
    <div className="group-chat-line group-card-settled">
      <span className="group-card-settled-mark" aria-hidden="true">✓</span>
      <span className="group-chat-line-who">{t("group.decision.answered")}</span>
      <span className="group-chat-line-sep" aria-hidden="true">·</span>
      <span className="group-chat-line-excerpt">{settled.title} → {settled.answer}</span>
    </div>
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

/** 누르고 있는 Enter·Space 의 반복은 카드 안에서 멈춘다 — 두 번째 확정이 나가지 않는다. */
function ignoreRepeat(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}
