import type { Translate } from "@fleet-console/i18n";
import type { ReactNode } from "react";

import type { Objective } from "../../shared/types.js";
import { getT, type ObjectiveMessageKey } from "../i18n/index.js";
import { openObjectivePopup } from "../objectives-panel.js";
import { openResultWindow } from "../result-window.js";
import { GoalArea, goalAreaCount } from "./goal-area.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 구성원/임무·결과물 본문은 다른 브랜치가 `rail/crew-missions-area.tsx`·`rail/results-area.tsx`로 만든다.
 * 임무 7에서 이 지역 자리표시를 그 파일의 import로 바꾼다. 이름과 시그니처는 그 계약과 같다.
 */
function CrewMissionsArea({ language }: { readonly objective: Objective; readonly language: "en" | "ko" }): ReactNode {
  return <p className="objective-rail-empty">{getT(language)("objectives.rail.area.placeholder")}</p>;
}

function crewMissionsCount(_objective: Objective): string {
  return "";
}

function ResultsArea({ language }: { readonly objective: Objective; readonly language: "en" | "ko" }): ReactNode {
  return <p className="objective-rail-empty">{getT(language)("objectives.rail.area.placeholder")}</p>;
}

function resultsCount(_objective: Objective): string {
  return "";
}

function statusOf(objective: Objective, t: T): string {
  if (objective.done) return t("objectives.graph.state.done");
  if (objective.awaitingReview) return t("objectives.objectives.review");
  if (objective.awaitingHandoff) return t("objectives.rail.goal.handoff");
  if (!objective.commenced) return t(objective.planning ? "objectives.state.planning" : "objectives.state.fresh");
  if (objective.stoppedAt !== null) return t("objectives.rail.goal.stopped");
  return t("objectives.graph.state.running");
}

/**
 * 우측 사이드바 3영역. 머리(제목·진행·상태) 아래를 같은 높이 세 칸으로 나누고, 각 칸은 따로 스크롤된다.
 */
export function ObjectiveRail({ objective, language }: { readonly objective: Objective; readonly language: "en" | "ko" }) {
  const t = getT(language);
  const done = objective.missions.filter((mission) => mission.done).length;
  const total = objective.missions.length;
  const progress = total > 0 ? t("objectives.rail.goal.progress", { done, total }) : "";
  const status = statusOf(objective, t);
  const goalCount = goalAreaCount(objective, language);
  const crewCount = crewMissionsCount(objective);
  const resultCount = resultsCount(objective);
  return (
    <div className="objective-rail">
      <div className="objective-rail-head">
        <strong>{objective.title}</strong>
        <span>{progress ? `${progress} · ${status}` : status}</span>
      </div>
      <div className="objective-rail-areas">
        <section className="objective-rail-area" aria-labelledby="objective-rail-goal">
          <div className="objective-rail-area-head">
            <h2 id="objective-rail-goal">{t("objectives.rail.area.goal")}</h2>
            {goalCount ? <span>{goalCount}</span> : null}
            <button type="button" onClick={(event) => openObjectivePopup(objective.id, "goal", undefined, event.currentTarget)}>{t("objectives.rail.area.expand")}</button>
          </div>
          <div className="objective-rail-area-body">
            <GoalArea objective={objective} language={language} />
          </div>
        </section>
        <section className="objective-rail-area" aria-labelledby="objective-rail-crew">
          <div className="objective-rail-area-head">
            <h2 id="objective-rail-crew">{t("objectives.rail.area.crew")}</h2>
            {crewCount ? <span>{crewCount}</span> : null}
            <button type="button" onClick={(event) => openObjectivePopup(objective.id, "crew", undefined, event.currentTarget)}>{t("objectives.rail.area.graph")}</button>
          </div>
          <div className="objective-rail-area-body">
            <CrewMissionsArea objective={objective} language={language} />
          </div>
        </section>
        <section className="objective-rail-area" aria-labelledby="objective-rail-results">
          <div className="objective-rail-area-head">
            <h2 id="objective-rail-results">{t("objectives.rail.area.results")}</h2>
            {resultCount ? <span>{resultCount}</span> : null}
            <button type="button" onClick={(event) => openResultWindow(objective.id, "", event.currentTarget)}>{t("objectives.rail.area.viewer")}</button>
          </div>
          <div className="objective-rail-area-body">
            <ResultsArea objective={objective} language={language} />
          </div>
        </section>
      </div>
    </div>
  );
}
