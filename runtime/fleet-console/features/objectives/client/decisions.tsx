import { useEffect, useState, type ReactNode } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { ownAnswer, type Decision, type Objective, type PersonHoldTarget } from "../shared/types.js";
import { actorDid } from "./actors.js";
import { livePersonHold } from "../shared/board-state.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { returnPersonHold } from "./objectives-state.js";

/**
 * 결정 — 사람이 결정 요청에 보낸 답은 「결정」에 질문마다 남는다. 요청에 답하는 칸은 가운데 대화의 결정 카드다(폰은 목표 탭의 결정 카드).
 * 읽기·세션 열기는 답이 아니다 — 요청은 보내기·지휘관의 철회·사람의 보드 편집으로만 정리되고, 그 정리는 서버가 한다.
 */

type T = Translate<ObjectiveMessageKey>;


/** 결정 섹션 머리 글리프 — 말풍선 안의 체크(사람이 보낸 답). */
export const DecisionGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M3.2 2.8h9.6a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H7.4L4.4 14v-2.4H3.2a1.4 1.4 0 0 1-1.4-1.4v-6a1.4 1.4 0 0 1 1.4-1.4z" /><path d="M5.6 7.2l1.7 1.7 3.2-3.4" /></svg>;

const stamp = (at: number, language: "en" | "ko") => new Date(at).toLocaleString(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 결정 요청 밖의 넘김 — 사령관이 사람에게 넘긴 기준 제안·완료 검토·후속 후보에 결정 카드와 같은 「사령관이 넘긴 이유」 한 줄과
 * 「사령관에게 돌려주기」를 단다. 그 대상의 넘김(`livePersonHold`)이 서 있을 때만 그린다. 돌려주기가 실패하면 한 줄로 말한다.
 * `label` 은 어느 항목의 넘김인지 밝힌다 — 폰(`phone`)에서는 제 카드로 선다(그 대상의 표면이 폰에 따로 없을 때). 데스크톱 넘김은 호스트 대화 카드가 그린다.
 * 폰 카드는 그 항목에 직접 답하는 단추(`answer`)를 돌려주기 옆에, 그 단추의 설명·사유(`children`)를 이유 아래에 받는다.
 * 답을 보내는 동안(`locked`)은 돌려주기를 잠근다 — 결정 카드가 보내는 중 돌려주기를 잠그는 것과 같다.
 */
export function PersonHoldNote({ objective, target, t, phone = false, label, answer, locked = false, children }: {
  readonly objective: Objective;
  readonly target: Exclude<PersonHoldTarget, "decision">;
  readonly t: T;
  readonly phone?: boolean;
  readonly label?: string;
  readonly answer?: ReactNode;
  readonly locked?: boolean;
  readonly children?: ReactNode;
}) {
  const hold = livePersonHold(objective, target);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [objective.id, hold?.at]);
  if (!hold) return null;
  const giveBack = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try { await returnPersonHold(objective.id, target); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  if (phone) {
    const body = (
      <>
        <p className="objectives-m-handed"><b>{t("objectives.decision.handed")}</b><LinkText text={hold.reason} /></p>
        {children}
        {failed ? <p className="objectives-m-fault" role="status">{t("objectives.decision.giveBackFailed")}</p> : null}
        <div className="objectives-m-ucard-ft">
          <span className="objectives-m-sp" />
          <button type="button" data-press="r3" className="objectives-m-b2 is-quiet" disabled={busy || locked} onClick={() => void giveBack()}>{t("objectives.decision.giveBack")}</button>
          {answer}
        </div>
      </>
    );
    return label ? <section className="objectives-m-card" aria-label={label}><h3 className="objectives-m-card-label">{label}</h3>{body}</section> : body;
  }
  return null;
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
            <p className="objectives-decision-q-copy">{decision.question.header ? <span className="objectives-decision-header">{decision.question.header}</span> : null}<LinkText text={decision.question.text} /></p>
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
