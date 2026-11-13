import type { Translate } from "@fleet-console/i18n";

import type { Objective } from "../../shared/types.js";
import { DecisionList } from "../decisions.js";
import { getT, type ObjectiveMessageKey } from "../i18n/index.js";
import { LinkText } from "../link-text.js";
import { hasDecisionRequest } from "../objectives-state.js";
import { Retrospective } from "../retrospective.js";

type T = Translate<ObjectiveMessageKey>;

/** 목표 영역 머리의 개수 — 성공 기준이 없으면 빈 문자열이라 머리를 비운다. */
export function goalAreaCount(objective: Objective, language: "en" | "ko"): string {
  if (objective.criteria.length === 0) return "";
  const met = objective.criteria.filter((criterion) => !!criterion.met).length;
  return getT(language)("objectives.rail.goal.criteriaCount", { met, total: objective.criteria.length });
}

/**
 * 목표 영역 본문. 순서: 브리핑·진행 → 대기 중 결정 → 성공 기준 → 결정 내역 → (완료된 목표) 회고.
 * 내용 없는 섹션은 숨기고, 아무것도 없으면 한 줄만 남긴다.
 */
export function GoalArea({ objective, language }: { readonly objective: Objective; readonly language: "en" | "ko" }) {
  const t = getT(language);
  const done = objective.missions.filter((mission) => mission.done).length;
  const total = objective.missions.length;
  const brief = objective.note.trim();
  const showBrief = brief.length > 0;
  const pending = hasDecisionRequest(objective) ? objective.decisionRequest : null;
  const met = objective.criteria.filter((criterion) => !!criterion.met).length;
  const history = objective.decisions.length > 0;
  const retro = objective.done !== null && objective.handoff !== null;
  if (!showBrief && pending === null && objective.criteria.length === 0 && !history && !retro) {
    return <p className="objective-rail-empty">{t("objectives.rail.area.empty")}</p>;
  }
  return (
    <>
      {showBrief ? (
        <section className="objective-rail-section">
          <h3 className="objective-rail-section-head">{t("objectives.rail.goal.brief")}</h3>
          {brief.length > 0 ? <p className="objective-rail-brief"><LinkText text={objective.note} /></p> : null}
          {total > 0 ? (
            <div className="objective-rail-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t("objectives.rail.goal.progress", { done, total })}>
              <i style={{ width: `${Math.round((done / total) * 100)}%` }} />
            </div>
          ) : null}
        </section>
      ) : null}
      {pending !== null ? (
        <section className="objective-rail-section">
          <h3 className="objective-rail-section-head">{t("objectives.rail.goal.decision")} <em>{pending.questions.length}</em></h3>
          {pending.questions.map((question) => (
            <div className="objective-rail-decision" key={question.id}>
              {question.header ? <b>{question.header}</b> : null}
              <span><LinkText text={question.text} /></span>
            </div>
          ))}
        </section>
      ) : null}
      {objective.criteria.length > 0 ? (
        <section className="objective-rail-section">
          <h3 className="objective-rail-section-head">{t("objectives.rail.goal.criteria")} <em>{t("objectives.rail.goal.criteriaCount", { met, total: objective.criteria.length })}</em></h3>
          <ul className="objective-rail-list">
            {objective.criteria.map((criterion, index) => {
              const satisfied = !!criterion.met;
              return (
                <li className="objective-rail-row" key={criterion.id}>
                  <span className={`objective-rail-num${satisfied ? " is-met" : ""}`} aria-label={t(satisfied ? "objectives.rail.goal.criterionMet" : "objectives.rail.goal.criterionOpen")}>{satisfied ? "✓" : index + 1}</span>
                  <span className="objective-rail-grow"><LinkText text={criterion.text} /></span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {history ? (
        <section className="objective-rail-section">
          <h3 className="objective-rail-section-head">{t("objectives.rail.goal.history")} <em>{objective.decisions.length}</em></h3>
          <DecisionList objective={objective} t={t} language={language} flash={null} memberMark={() => null} />
        </section>
      ) : null}
      {retro && objective.handoff ? <RetroSection objective={objective} t={t} /> : null}
    </>
  );
}

function RetroSection({ objective, t }: { readonly objective: Objective; readonly t: T }) {
  const handoff = objective.handoff;
  if (!handoff) return null;
  return (
    <section className="objective-rail-section">
      <h3 className="objective-rail-section-head">{t("objectives.rail.goal.retro")}</h3>
      <Retrospective
        t={t}
        by={handoff.by}
        good={handoff.retrospective?.wentWell.map((pair) => ({ text: pair.point, aside: pair.because })) ?? []}
        regret={handoff.retrospective?.fellShort.map((pair) => ({ text: pair.point, aside: pair.ifOnly })) ?? []}
      />
    </section>
  );
}
