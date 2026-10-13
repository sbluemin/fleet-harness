import { useEffect, useState } from "react";

import { SyncedTextarea } from "@fleet-console/sdk/composer";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { CommodoreAsk } from "../server/commodore/types.js";
import { MAX_SHORT_INPUT } from "../server/types.js";
import { clockTime } from "./commodore-header.js";
import { errorWord } from "./commodore-chat.js";
import { CommodoreMentionGlyph } from "./commodore-mention-glyph.js";
import { answerCommodoreAsk, askObjectiveTitle, openAsks, useCommodore } from "./commodore-state.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { revealObjective, useObjectiveTheater } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관의 질문 — 사령관이 보드 항목이 아닌 일을 사람에게 직접 물은 것. 사령관 기록(시트·대화 중심 화면·폰) 맨 위에 고정된 카드로
 * 서고, 결정 요청 카드와 같은 문법이다: 묻는 이유 한 줄, 질문마다 선택지와 「내 의견」, 답이 갈 곳 한 줄. 모든 질문에 답해야 보낸다.
 * 보내거나 사령관이 거두면 질문이 끝나 카드가 조용히 내려가고, 기록에는 「사람에게 물음」·「사람이 답함」 줄이 남는다.
 * 데스크톱은 결정 칸의 클래스를, 폰(`phone`)은 사령관 화면의 모바일 문법을 쓴다.
 */
/**
 * 질문이 이미 끝났다는 거절 — 상태를 다시 읽으면 카드가 곧 걷히므로 그 사유는 카드 밖(기록 칸의 실패 줄)이 말한다.
 * 기록 칸의 실패 문구 함수가 이 코드를 그 사유 낱말(`errorWord`)로 옮긴다.
 */
export const ENDED_ASK_CODES: ReadonlySet<string> = new Set(["ask_withdrawn", "ask_already_answered"]);

/** `onEnded` — 질문이 이미 끝났다는 거절을 카드 밖에 남기는 기록 칸의 실패 경로. */
export function CommodoreAskCards({ theaterId, t, phone = false, onEnded }: { readonly theaterId: string; readonly t: T; readonly phone?: boolean; readonly onEnded?: (error: unknown) => void }) {
  const { view } = useCommodore(theaterId);
  const board = useObjectiveTheater(theaterId);
  const asks = openAsks(theaterId);
  if (asks.length === 0) return null;
  const titleOf = (objectiveId: string) => askObjectiveTitle(board, view?.asks?.objectives, objectiveId);
  return (
    <div className={phone ? "objectives-cm-asks" : "objectives-asks"}>
      {asks.map((ask) => <AskCard key={ask.id} ask={ask} theaterId={theaterId} objectiveTitle={ask.objectiveId ? titleOf(ask.objectiveId) : null} t={t} phone={phone} onEnded={onEnded} />)}
    </div>
  );
}

interface Draft { readonly picked: readonly string[]; readonly text: string }
const EMPTY: Draft = { picked: [], text: "" };
/** 답 초안 — 다른 화면을 보다 와도 남는다(질문 id 별, 이 탭의 메모리). 보내면 비운다. */
const drafts = new Map<string, Readonly<Record<string, Draft>>>();

function AskCard({ ask, theaterId, objectiveTitle, t, phone, onEnded }: {
  readonly ask: CommodoreAsk;
  readonly theaterId: string;
  readonly objectiveTitle: string | null;
  readonly t: T;
  readonly phone: boolean;
  readonly onEnded: ((error: unknown) => void) | undefined;
}) {
  const [draft, setDraft] = useState<Readonly<Record<string, Draft>>>(() => drafts.get(ask.id) ?? {});
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => { setDraft(drafts.get(ask.id) ?? {}); setFault(null); }, [ask.id]);
  const of = (questionId: string) => draft[questionId] ?? EMPTY;
  const edit = (questionId: string, next: Draft) => {
    const map = { ...draft, [questionId]: next };
    drafts.set(ask.id, map);
    setDraft(map);
  };
  const pick = (questionId: string, optionId: string, multi: boolean) => {
    const current = of(questionId);
    const on = current.picked.includes(optionId);
    edit(questionId, { ...current, picked: multi ? (on ? current.picked.filter((id) => id !== optionId) : [...current.picked, optionId]) : on ? [] : [optionId] });
  };
  const total = ask.questions.length;
  const many = total > 1;
  const done = ask.questions.filter((question) => of(question.id).picked.length > 0 || of(question.id).text.trim().length > 0).length;
  const submit = async () => {
    if (sending || done !== total) return;
    setSending(true);
    setFault(null);
    try {
      await answerCommodoreAsk(theaterId, ask.id, ask.questions.map((question) => ({ questionId: question.id, selectedOptionIds: of(question.id).picked, text: of(question.id).text.trim() })));
      drafts.delete(ask.id);
    } catch (error) {
      // 아는 거절(이미 답함·거둠·어긋난 답)은 그 사유로, 그 밖은 일반 실패로 — 고른 것과 쓴 답은 그대로 둔다.
      const code = error instanceof Error ? error.message : "";
      if (onEnded && ENDED_ASK_CODES.has(code)) { onEnded(error); return; }
      const word = errorWord(t, code);
      setFault(code && word !== code ? word : t("objectives.decision.failed"));
    } finally { setSending(false); }
  };
  const objective = ask.objectiveId ? (
    <button type="button" className={phone ? "objectives-cm-ask-objective" : "objectives-ask-objective"} disabled={objectiveTitle === null} onClick={() => revealObjective({ objectiveId: ask.objectiveId! })}>
      {objectiveTitle ?? t("objectives.ask.objectiveGone")}
    </button>
  ) : null;
  const c = phone
    ? { card: "objectives-cm-ask", head: "objectives-cm-ask-hd", reason: "objectives-cm-ask-reason", q: "objectives-cm-ask-q", text: "objectives-cm-ask-qtext", opts: "objectives-cm-ask-opts", opt: "objectives-cm-ask-opt", free: "objectives-cm-ask-free", foot: "objectives-cm-ask-ft", route: "objectives-cm-ask-route", send: "objectives-cm-ask-send", fault: "objectives-cm-ask-fault" }
    : { card: "objectives-decision-request objectives-ask", head: "objectives-decision-head", reason: "objectives-decision-handed", q: "objectives-decision-q", text: "objectives-decision-q-text", opts: "objectives-decision-opts", opt: "objectives-decision-opt", free: "objectives-decision-free", foot: "objectives-decision-submit", route: "objectives-decision-route", send: "objectives-decision-send", fault: "objectives-decision-fault" };
  return (
    <section className={c.card} aria-label={t("objectives.ask.title")}>
      {/* 사람의 결정을 기다린다 — 결정 요청과 같은 궤도. 폰은 테두리 잉크가 말한다. */}
      {phone ? null : <span className="objectives-decision-orbit" aria-hidden="true" />}
      <div className={c.head}>
        <span className={phone ? "objectives-cm-ask-glyph" : "objectives-decision-glyph"}><CommodoreMentionGlyph className="objectives-ask-glyph" /></span>
        <span>{t("objectives.ask.title")}</span>
        <time dateTime={new Date(ask.at).toISOString()}>{clockTime(ask.at)}</time>
        {many ? <span className={phone ? "objectives-cm-ask-n" : "objectives-decision-n"}>{t("objectives.decision.questions", { count: total })}</span> : null}
      </div>
      <p className={c.reason}><b>{t("objectives.ask.reason")}</b><LinkText text={ask.reason} /></p>
      {objective ? <p className={phone ? "objectives-cm-ask-about" : "objectives-ask-about"}>{t("objectives.ask.about")} {objective}</p> : null}
      {ask.questions.map((question, index) => {
        const current = of(question.id);
        const hasOptions = question.options.length > 0;
        return (
          <div key={question.id} className={c.q}>
            <p className={c.text}>{many ? <span className="objectives-ask-n">{index + 1}</span> : null}<LinkText text={question.text} /></p>
            {hasOptions ? (
              <div className={c.opts} role={question.multiSelect ? "group" : "radiogroup"} aria-label={t("objectives.decision.optionsAria", { n: index + 1 })}>
                {question.options.map((option) => {
                  const on = current.picked.includes(option.id);
                  return (
                    <div key={option.id} className={`${c.opt}${question.multiSelect ? " is-multi" : ""}`}>
                      <button type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={sending} className={phone ? "objectives-cm-ask-pick" : "objectives-decision-opt-pick"} onClick={() => pick(question.id, option.id, question.multiSelect)}>
                        <span className={phone ? "objectives-cm-ask-ind" : "objectives-decision-ind"} aria-hidden="true" />
                        <span>{option.label}</span>
                      </button>
                      {option.description ? <small>{option.description}</small> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            <SyncedTextarea
              className={c.free}
              rows={1}
              maxLength={MAX_SHORT_INPUT}
              disabled={sending}
              value={current.text}
              aria-label={t("objectives.decision.writeAria", { n: index + 1 })}
              placeholder={t(hasOptions ? "objectives.ask.writeOwn" : "objectives.decision.write")}
              onChange={(event) => edit(question.id, { ...current, text: event.target.value })}
            />
          </div>
        );
      })}
      <div className={c.foot}>
        <span className={c.route}>{many ? `${t("objectives.decision.progress", { done, total })} · ` : ""}{t("objectives.ask.route")}</span>
        <button type="button" className={c.send} data-press={phone ? "r3" : undefined} disabled={sending || done !== total} onClick={() => void submit()}>{t(sending ? "objectives.decision.sending" : "objectives.ask.send")}</button>
      </div>
      {fault ? <p className={c.fault} role="status">{fault}</p> : null}
    </section>
  );
}
