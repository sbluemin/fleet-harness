import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { ownAnswer, type Decision, type DecisionQuestion, type Objective } from "../server/types.js";
import { actorDid } from "./actors.js";
import { useCommodoreBoard } from "./commodore-state.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { SyncedTextarea } from "@fleet-console/sdk/composer";

/**
 * 결정 요청과 결정 — 지휘관이 보드에 올린 질문 묶음에 사람이 한 번에 답하고, 보낸 답은 「결정」에 질문마다 남는다.
 * 요청 칸은 하단 띠와 따로 서서 지휘관이 일하는 중(띠가 「중단」)에도 가려지지 않는다. 읽기·세션 열기는 답이 아니다 —
 * 요청은 보내기·지휘관의 철회·사람의 보드 편집으로만 정리되고, 그 정리는 서버가 한다.
 */

type T = Translate<ObjectiveMessageKey>;

/** 결정 요청 표식 — 물음표 말풍선. 허용 대기(청록 점)·도착(초록)과 모양·색이 다르다. */
export const RequestGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M3.2 2.8h9.6a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H7.4L4.4 14v-2.4H3.2a1.4 1.4 0 0 1-1.4-1.4v-6a1.4 1.4 0 0 1 1.4-1.4z" /><path d="M6.5 5.6a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.6.5-.6.9v.3" /><circle cx="8" cy="9.5" r=".2" fill="currentColor" /></svg>;
/** 결정 표식 — 같은 말풍선에 체크. 임무 줄의 결정 수와 「결정」 머리에 쓴다. */
export const DecisionGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M3.2 2.8h9.6a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H7.4L4.4 14v-2.4H3.2a1.4 1.4 0 0 1-1.4-1.4v-6a1.4 1.4 0 0 1 1.4-1.4z" /><path d="M5.6 7.2l1.7 1.7 3.2-3.4" /></svg>;
const GoGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9.5 3.5h3v3M12.5 3.5 7.5 8.5" /></svg>;

/** own — 「내 의견으로 답하기」 줄을 골랐다. 보드가 붙이는 줄이라 서버로는 고른 것 없이 글만 간다. */
interface Draft { readonly picked: readonly string[]; readonly text: string; readonly own?: boolean }
const EMPTY_DRAFT: Draft = { picked: [], text: "" };
const answered = (draft: Draft) => draft.picked.length > 0 || draft.text.trim().length > 0;
/** 내 의견 줄이 켜졌다 — 고른 것 없이 그 줄을 골랐거나 글을 썼다. 선택지가 있는 질문에서 글만 보낸 답은 곧 내 의견이다. */
const ownOn = (draft: Draft) => draft.picked.length === 0 && (draft.own === true || draft.text.trim().length > 0);
/**
 * 답변 초안 — 다른 목표를 보다 와도 남는다(목표 id 별, 이 탭의 메모리). 요청 id 가 다르면 교체·철회된 앞 요청의 초안이라
 * 버린다. 보내면 비운다. 플러그인 번들 안에서만 쓰는 보기 상태라 호스트와 나누지 않는다.
 */
const draftStore = new Map<string, { readonly requestId: string; readonly drafts: Readonly<Record<string, Draft>> }>();
const storedDrafts = (objectiveId: string, requestId: string | undefined): Readonly<Record<string, Draft>> => {
  const stored = draftStore.get(objectiveId);
  if (stored && stored.requestId === requestId) return stored.drafts;
  draftStore.delete(objectiveId);
  return {};
};

/** 직접 쓰기 칸을 글 높이에 맞춘다 — border-box 라 위아래 테두리까지 더해야 마지막 줄이 잘리지 않는다. */
const fitField = (field: HTMLTextAreaElement) => {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
};

const clock = (at: number, language: "en" | "ko") => new Date(at).toLocaleTimeString(language === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
const stamp = (at: number, language: "en" | "ko") => new Date(at).toLocaleString(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 결정 요청 칸 — 질문마다 선택지(목록 줄)와 늘 열린 직접 쓰기 칸. 선택지가 있으면 끝에 「내 의견으로 답하기」 줄이 늘 붙고,
 * 그 줄은 쓴 글이 있어야 답이 된다. 모든 질문에 답해야 보낸다. 질문이 하나면 번호·셈을 숨겨
 * 한 문장 요청처럼 읽힌다. 보내기가 실패하면 고른 것과 쓴 답을 지키고 사유 한 줄을 보인다.
 */
export function DecisionRequestBlock({ objective, t, language, send, missionNumber, memberMark, onOpenSession, onShowMission }: {
  readonly objective: Objective;
  readonly t: T;
  readonly language: "en" | "ko";
  /** 보내기 — 실패는 코드를 던진다. */
  readonly send: (requestId: string, answers: readonly { questionId: string; selectedOptionIds: readonly string[]; text: string }[]) => Promise<unknown>;
  readonly missionNumber: (missionId: string) => number;
  readonly memberMark: (memberId: string) => { readonly mark: ReactNode; readonly role: string; readonly live: boolean } | null;
  readonly onOpenSession: (memberId: string) => void;
  readonly onShowMission: (missionId: string) => void;
}) {
  const request = objective.decisionRequest;
  const [drafts, setDrafts] = useState(() => storedDrafts(objective.id, request?.id));
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // 되살린 초안은 onChange 를 거치지 않는다 — 그려질 때 칸 높이를 글에 맞춘다.
  useLayoutEffect(() => { sectionRef.current?.querySelectorAll("textarea").forEach(fitField); }, [objective.id, request?.id]);
  // 새 요청은 새 질문이다 — 앞 요청에 쓰던 답을 옮겨 붙이지 않는다.
  useEffect(() => { setDrafts(storedDrafts(objective.id, request?.id)); setFault(null); }, [objective.id, request?.id]);
  if (!request) return null;
  const total = request.questions.length;
  const many = total > 1;
  const draftOf = (question: DecisionQuestion) => drafts[question.id] ?? EMPTY_DRAFT;
  const done = request.questions.filter((question) => answered(draftOf(question))).length;
  const edit = (question: DecisionQuestion, next: Draft) => {
    const nextDrafts = { ...drafts, [question.id]: next };
    draftStore.set(objective.id, { requestId: request.id, drafts: nextDrafts });
    setDrafts(nextDrafts);
  };
  const pick = (question: DecisionQuestion, optionId: string) => {
    const draft = draftOf(question);
    const on = draft.picked.includes(optionId);
    edit(question, { ...draft, own: false, picked: question.multiSelect ? (on ? draft.picked.filter((id) => id !== optionId) : [...draft.picked, optionId]) : on ? [] : [optionId] });
  };
  // 내 의견 — 여러 개 고르는 질문에서도 홀로 선다. 고른 것을 비우고 쓰기 칸으로 간다.
  const pickOwn = (question: DecisionQuestion) => {
    edit(question, { ...draftOf(question), picked: [], own: true });
    sectionRef.current?.querySelector<HTMLTextAreaElement>(`textarea[data-question-id="${CSS.escape(question.id)}"]`)?.focus();
  };
  // 이 화면에서 보내는 중이 아닌데 전달 중 표시가 남았다 — 앞선 보내기의 결과를 서버가 확인하지 못했다.
  const unconfirmed = !sending && objective.decisionDelivery?.requestId === request.id;
  const submit = async () => {
    if (sending || done !== total) return;
    setSending(true);
    setFault(null);
    try {
      await send(request.id, request.questions.map((question) => ({ questionId: question.id, selectedOptionIds: draftOf(question).picked, text: draftOf(question).text })));
      draftStore.delete(objective.id);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setFault(code === "decision_request_changed" ? t("objectives.decision.changed") : code === "decision_delivering" ? t("objectives.decision.delivering") : t("objectives.decision.failed"));
    } finally { setSending(false); }
  };
  // 자율 운영 중이면 사령관이 운영하는 목표의 요청을 맡는다 — 사람도 그대로 답할 수 있고, 먼저 보낸 답이 이긴다.
  // 사람이 운영하는 목표의 요청으로는 사령관이 깨어나지 않으므로 「답하는 중」을 달지 않는다(서버 판정 `operator`).
  const commodore = useCommodoreBoard(objective.theaterId);
  return (
    <section ref={sectionRef} className="objectives-decision-request" aria-label={t("objectives.decision.request")}>
      <span className="objectives-decision-orbit" aria-hidden="true" />
      <div className="objectives-decision-head">
        <span className="objectives-decision-glyph"><RequestGlyph /></span>
        <span>{t("objectives.decision.request")}</span>
        <time dateTime={new Date(request.createdAt).toISOString()}>{clock(request.createdAt, language)}</time>
        {many ? <span className="objectives-decision-n">{t("objectives.decision.questions", { count: total })}</span> : null}
        {commodore.active && objective.operator !== "human" ? <span className="objectives-decision-handler" title={t("objectives.commodore.decisionHint")}>{t("objectives.commodore.note.answering")}</span> : null}
      </div>
      <div className="objectives-decision-body">
        {request.questions.map((question, index) => {
          const draft = draftOf(question);
          const n = index + 1;
          const missionN = question.missionId ? missionNumber(question.missionId) : 0;
          const member = question.memberId ? memberMark(question.memberId) : null;
          const hasOptions = question.options.length > 0;
          const own = hasOptions && ownOn(draft);
          const ownLabelId = `objectives-decision-own-label-${question.id}`;
          return (
            <div key={question.id} className="objectives-decision-q">
              <div className="objectives-decision-q-top">
                {many ? <span className="objectives-decision-q-n">{n}</span> : null}
                <p className="objectives-decision-q-text"><LinkText text={question.text} /></p>
              </div>
              {missionN > 0 || member ? (
                <div className="objectives-decision-refs">
                  {missionN > 0 ? <button type="button" className="objectives-decision-ref" onClick={() => onShowMission(question.missionId!)}><span className="objectives-decision-ref-n">{missionN}</span>{objective.missions[missionN - 1]?.text ?? ""}</button> : null}
                  {member ? (member.live
                    ? <button type="button" className="objectives-decision-ref is-go" onClick={() => onOpenSession(question.memberId!)}>{member.mark}{t("objectives.decision.openSession", { role: member.role })}<GoGlyph /></button>
                    : <span className="objectives-decision-ref">{member.mark}{member.role}</span>) : null}
                </div>
              ) : null}
              {question.options.length > 0 ? (
                <div className="objectives-decision-opts" role={question.multiSelect ? "group" : "radiogroup"} aria-label={t("objectives.decision.optionsAria", { n })}>
                  {question.options.map((option) => {
                    const on = draft.picked.includes(option.id);
                    // 설명은 링크 때문에 버튼 밖에 서지만, 보조 기술에는 그 선택지의 설명으로 이어 둔다.
                    const descId = `objectives-decision-desc-${question.id}-${option.id}`;
                    return (
                      <div key={option.id} className={`objectives-decision-opt${question.multiSelect ? " is-multi" : ""}`}>
                        <button type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={sending} className="objectives-decision-opt-pick" aria-describedby={option.description ? descId : undefined} onClick={() => pick(question, option.id)}>
                          <span className="objectives-decision-ind" aria-hidden="true" />
                          <span>{option.label}</span>
                        </button>
                        {option.description ? <small id={descId} onClick={(event) => {
                          if (sending) return;
                          const target = event.target;
                          if (target instanceof Element && target.closest("a")) return;
                          pick(question, option.id);
                        }}><LinkText text={option.description} /></small> : null}
                      </div>
                    );
                  })}
                  {question.multiSelect ? <span className="objectives-decision-hint">{t("objectives.decision.multiHint")}</span> : null}
                  {/* 보드가 늘 붙이는 줄 — 저장된 선택지가 아니어서 점선으로 갈리고, 표시기도 점선 원이다. */}
                  <div className="objectives-decision-own-sep" aria-hidden="true" />
                  <div className="objectives-decision-opt is-own">
                    <button type="button" role="radio" aria-checked={own} disabled={sending} className="objectives-decision-opt-pick" aria-describedby={`objectives-decision-desc-${question.id}-own`} onClick={() => pickOwn(question)}>
                      <span className="objectives-decision-ind" aria-hidden="true" />
                      <span>{t("objectives.decision.own")}</span>
                    </button>
                    <small id={`objectives-decision-desc-${question.id}-own`} onClick={() => { if (!sending) pickOwn(question); }}>{t("objectives.decision.ownHint")}</small>
                  </div>
                </div>
              ) : null}
              {own ? <span id={ownLabelId} className="objectives-decision-own-label">{t("objectives.decision.ownLabel")}</span> : null}
              <SyncedTextarea
                className="objectives-decision-free"
                rows={1}
                maxLength={50}
                disabled={sending}
                value={draft.text}
                data-question-id={question.id}
                aria-label={t("objectives.decision.writeAria", { n })}
                aria-describedby={own ? ownLabelId : undefined}
                placeholder={t(!hasOptions ? "objectives.decision.write" : own ? "objectives.decision.writeOwn" : draft.picked.length > 0 ? "objectives.decision.writeAdd" : "objectives.decision.writeMore")}
                // 고른 것 없이 쓰기 시작하면 내 의견이다 — 글을 지워도 그 줄은 켜진 채 남는다.
                onChange={(event) => { const text = event.target.value; edit(question, { ...draft, text, own: draft.own || (draft.picked.length === 0 && text.trim().length > 0) }); fitField(event.currentTarget); }}
                onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
              />
            </div>
          );
        })}
      </div>
      <div className="objectives-decision-submit">
        {many ? <span className="objectives-decision-progress">{t("objectives.decision.progress", { done, total })}</span> : null}
        <button type="button" className="objectives-decision-send" disabled={sending || done !== total} onClick={() => void submit()}>{t(sending ? "objectives.decision.sending" : "objectives.decision.send")}</button>
      </div>
      {fault ? <p className="objectives-decision-fault" role="status">{fault}</p>
        : unconfirmed ? <p className="objectives-decision-fault" role="status">{t("objectives.decision.unknown")}</p>
        : null}
    </section>
  );
}

const SHOWN = 3;

/** 결정 한 건의 답 — 고른 선택지(답한 순간의 사본 이름)를 「 · 」로 잇고, 직접 쓴 말은 다음 줄에 그대로. 내 의견은 칩이 앞에 선다. */
const answerText = (decision: Decision): string => {
  const picked = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
  return [picked.join(" · "), decision.answer.text].filter((part) => part.trim().length > 0).join("\n");
};

/**
 * 「결정」 — 사람이 보낸 답이 질문마다 한 건씩 쌓인다(최신이 위). 최근 셋만 보이고 나머지는 접힌다. 임무 줄의 결정 표식이
 * 가리키면 그 결정을 펼쳐 비춘다. 지우거나 고치는 길은 없다.
 */
export function DecisionList({ objective, t, language, flash, memberMark }: {
  readonly objective: Objective;
  readonly t: T;
  readonly language: "en" | "ko";
  /** 비출 결정 id — 접힌 곳에 있으면 펼친다. */
  readonly flash: string | null;
  readonly memberMark: (memberId: string) => { readonly mark: ReactNode; readonly role: string } | null;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const list = [...objective.decisions].reverse();
  const flashAt = flash ? list.findIndex((decision) => decision.id === flash) : -1;
  const open = unfolded || flashAt >= SHOWN;
  const shown = open ? list : list.slice(0, SHOWN);
  const hidden = list.length - shown.length;
  return (
    <div className="objectives-decisions">
      {shown.map((decision) => {
        const missionN = decision.missionId ? objective.missions.findIndex((mission) => mission.id === decision.missionId) + 1 : 0;
        const member = decision.memberId ? memberMark(decision.memberId) : null;
        return (
          <div key={decision.id} data-decision-id={decision.id} className={`objectives-decision${flash === decision.id ? " is-flash" : ""}`}>
            <p className="objectives-decision-q-copy"><LinkText text={decision.question.text} /></p>
            <p className="objectives-decision-a">{ownAnswer(decision.question, decision.answer) ? <span className="objectives-decision-chip">{t("objectives.decisions.own")}</span> : null}<LinkText text={answerText(decision)} /></p>
            <p className="objectives-decision-meta">
              <span>{stamp(decision.at, language)}</span>
              {missionN > 0 ? <span>{t("objectives.decisions.mission", { n: missionN })}</span> : null}
              {member ? <span>{member.mark}{member.role}</span> : null}
              {((did) => (did ? <span className="objectives-decision-by">{did}</span> : null))(actorDid(t, decision.by, "answered"))}
            </p>
          </div>
        );
      })}
      {hidden > 0 ? <button type="button" className="objectives-decisions-fold" onClick={() => setUnfolded(true)}>{t("objectives.decisions.more", { count: hidden })}</button>
        : open && list.length > SHOWN ? <button type="button" className="objectives-decisions-fold" onClick={() => setUnfolded(false)}>{t("objectives.decisions.less", { count: SHOWN })}</button> : null}
    </div>
  );
}
