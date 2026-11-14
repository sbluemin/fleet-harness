import { useState, type ReactNode } from "react";

import type { Translate } from "@fleet-console/i18n";

import { ownAnswer, type Decision, type Objective } from "../shared/types.js";
import { actorDid } from "./actors.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";

/**
 * 결정 — 사령관이 남긴 결정과 기존 요청의 답을 같은 기록으로 보여 준다. 결정 기록을 지우거나 고치는 길은 없다.
 */

type T = Translate<ObjectiveMessageKey>;



const stamp = (at: number, language: "en" | "ko") => new Date(at).toLocaleString(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const SHOWN = 3;

/** 결정 한 건의 답 — 고른 선택지(답한 순간의 사본 이름)를 「 · 」로 잇고, 직접 쓴 말은 다음 줄에 그대로. 내 의견은 칩이 앞에 선다. 「결정 안 함」으로 닫힌 건은 그 문구 하나로 선다. */
const answerText = (decision: Decision, declinedText: string): string => {
  if (decision.declined === true) return declinedText;
  const picked = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
  return [picked.join(" · "), decision.answer.text].filter((part) => part.trim().length > 0).join("\n");
};

/**
 * 「결정」 — 사령관의 결정과 기존 답이 한 건씩 쌓인다(최신이 위). 최근 셋만 보이고 나머지는 접힌다. 임무 줄의 결정 표식이
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
            <p className="objectives-decision-a">{decision.declined !== true && ownAnswer(decision.question, decision.answer) ? <span className="objectives-decision-chip">{t("objectives.decisions.own")}</span> : null}<LinkText text={answerText(decision, t("objectives.decisions.declined"))} /></p>
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
