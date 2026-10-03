import type { ArchiveSectionContext, ArchiveSectionDescriptor } from "@fleet-console/sdk/plugin";
import { StatusGlyph } from "@fleet-console/sdk/components/status-glyph";

import type { Objective } from "../server/types.js";
import { actorDid } from "./actors.js";
import { getT } from "./i18n/index.js";
import { activeTheaterId, objectivesApi, openObjectiveFromCluster, post, readTheater, revealObjective, subscribeObjective, useObjectiveTheater } from "./objectives-state.js";
import { TidiedList } from "./tidied.js";

/**
 * 보관함 칸 — 끝난 목표(「완료」)와 지우거나 합친 목표(「정리된 목표」)는 사이드바 트리에 서지 않고 호스트 보관함에 선다.
 * 정리된 목표의 「비우기」가 영구 삭제의 유일한 입구이며, 두 번 눌러 확정한다(TidiedList).
 */

const theaterOf = (theaterId: string | null) => theaterId ?? activeTheaterId();
const matching = (objectives: readonly Objective[], query = "") => objectives.filter((objective) => objective.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
const completedOf = (objectives: readonly Objective[]) => objectives.filter((objective) => objective.done && !objective.removed)
  .sort((a, b) => (b.done?.at ?? 0) - (a.done?.at ?? 0));
const tidiedOf = (objectives: readonly Objective[]) => objectives.filter((objective) => objective.removed);

function openObjective(objectiveId: string, close: () => void): void {
  revealObjective({ objectiveId });
  openObjectiveFromCluster();
  close();
}

function CompletedSection({ language, theaterId, close, query }: ArchiveSectionContext) {
  const t = getT(language);
  const objectives = matching(completedOf(useObjectiveTheater(theaterOf(theaterId)).objectives), query);
  const day = new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric" });
  return (
    <ul className="objectives-archive-list">
      {objectives.map((objective) => (
        <li key={objective.id}>
          <button type="button" className="objectives-archive-row" onClick={() => openObjective(objective.id, close)}>
            <StatusGlyph state="done" label={t("objectives.archive.doneGlyph")} decorative />
            <span className="objectives-archive-title">{objective.title}</span>
            {objective.done ? <span className="objectives-archive-meta">{[day.format(new Date(objective.done.at)), actorDid(t, objective.done.by, "completed")].filter(Boolean).join(" · ")}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TidiedSection({ language, theaterId, close, query }: ArchiveSectionContext) {
  const t = getT(language);
  const objectives = matching(tidiedOf(useObjectiveTheater(theaterOf(theaterId)).objectives), query);
  const call = async <R,>(path: string, body: Record<string, unknown>): Promise<R | null> => {
    const api = objectivesApi();
    if (!api) return null;
    return post<R>(api, path, { ...body, language }).catch(() => null);
  };
  return (
    <div className="objectives-archive-tidied" role="listbox" aria-label={t("objectives.archive.tidied")}>
      <TidiedList objectives={objectives} t={t} language={language} selected={null} onSelect={(objectiveId) => openObjective(objectiveId, close)} call={call} />
    </div>
  );
}

export const objectivesArchiveSections: readonly ArchiveSectionDescriptor[] = [
  {
    id: "completed",
    title: (language) => getT(language)("objectives.archive.completed"),
    subscribe: subscribeObjective,
    count: (theaterId, query) => matching(completedOf(readTheater(theaterOf(theaterId)).objectives), query).length,
    render: (ctx) => <CompletedSection {...ctx} />,
  },
  {
    id: "tidied",
    title: (language) => getT(language)("objectives.archive.tidied"),
    subscribe: subscribeObjective,
    count: (theaterId, query) => matching(tidiedOf(readTheater(theaterOf(theaterId)).objectives), query).length,
    render: (ctx) => <TidiedSection {...ctx} />,
  },
];
