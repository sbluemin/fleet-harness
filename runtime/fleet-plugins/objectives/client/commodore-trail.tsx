import { useMemo } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { Objective, ObjectiveActor } from "../server/types.js";
import { clockTime } from "./commodore-row.js";
import { objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";
import { revealObjective, useObjectiveTheater } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관이 목표에서 한 일 — 기록 곁 칸. 원천은 보드다: 목표마다 남는 행위 기록 중 행위자가 사령관인 것, 사령관이 대신 답한 결정,
 * 사령관이 만든 목표. 새 저장소는 없다. 목표별로 묶어 최근 것이 위에 서고, 줄을 누르면 그 시각의 기록 턴이 기록 칸에서 드러난다.
 * 메시지·중지·압축은 보드 행위로 남지 않아 여기 서지 않는다(기록의 도구 줄이 말한다).
 */

export interface CommodoreTrailEntry {
  readonly key: string;
  readonly at: number;
  readonly kind: "act" | "decision";
  readonly word: string;
  readonly detail?: string;
  readonly why?: string;
}

export interface CommodoreTrailGroup {
  readonly objectiveId: string;
  readonly title: string;
  readonly done: boolean;
  readonly latest: number;
  readonly entries: readonly CommodoreTrailEntry[];
}

/** 한 목표에서 보이는 줄 수 — 그보다 오래된 것은 목표를 열어 본다. */
const ENTRIES_PER_OBJECTIVE = 4;

const commodoreActor = (by: ObjectiveActor | undefined, theaterId: string): Extract<ObjectiveActor, { kind: "commodore" }> | null =>
  typeof by === "object" && by.kind === "commodore" && by.theaterId === theaterId ? by : null;

function actWord(t: T, kind: string): string {
  const key = `objectives.prov.act.${kind}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : kind;
}

export function commodoreTrail(t: T, theaterId: string, objectives: readonly Objective[]): readonly CommodoreTrailGroup[] {
  const groups: CommodoreTrailGroup[] = [];
  for (const objective of objectives) {
    const entries: CommodoreTrailEntry[] = [];
    const added = objective.addedBy && "kind" in objective.addedBy && objective.addedBy.theaterId === theaterId;
    if (added) entries.push({ key: `${objective.id}:added`, at: objective.createdAt, kind: "act", word: t("objectives.prov.addedByCommodore") });
    for (const action of objective.actions ?? []) {
      const by = commodoreActor(action.by, theaterId);
      if (!by) continue;
      entries.push({ key: action.id, at: action.at, kind: "act", word: actWord(t, action.kind), ...(by.why ? { why: by.why } : {}) });
    }
    for (const decision of objective.decisions) {
      const by = commodoreActor(decision.by, theaterId);
      if (!by) continue;
      const chosen = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
      const answer = [...chosen, ...(decision.answer.text.trim() ? [decision.answer.text.trim()] : [])].join(", ");
      entries.push({ key: decision.id, at: decision.at, kind: "decision", word: decision.question.text, ...(answer ? { detail: answer } : {}), ...(by.why ? { why: by.why } : {}) });
    }
    if (entries.length === 0) continue;
    entries.sort((a, b) => b.at - a.at);
    groups.push({ objectiveId: objective.id, title: objective.title, done: objective.done !== null, latest: entries[0]!.at, entries: entries.slice(0, ENTRIES_PER_OBJECTIVE) });
  }
  return groups.sort((a, b) => b.latest - a.latest);
}

/** 오늘이면 시각만, 아니면 월-일과 시각. */
function when(at: number): string {
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return clockTime(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${clockTime(at)}`;
}

export function CommodoreTrail({ t, theaterId, onReveal }: { readonly t: T; readonly theaterId: string; readonly onReveal?: (at: number) => void }) {
  const { objectives } = useObjectiveTheater(theaterId);
  const groups = useMemo(() => commodoreTrail(t, theaterId, objectives), [t, theaterId, objectives]);
  return (
    <section className="objectives-commodore-trail" aria-label={t("objectives.commodore.trail.title")}>
      <h3 className="objectives-commodore-trail-title">{t("objectives.commodore.trail.title")}</h3>
      {groups.length === 0 ? <p className="objectives-commodore-trail-empty">{t("objectives.commodore.trail.empty")}</p> : (
        <ul className="objectives-commodore-trail-list">
          {groups.map((group) => (
            <li key={group.objectiveId} className={`objectives-commodore-trail-group${group.done ? " is-done" : ""}`}>
              <button type="button" className="objectives-commodore-trail-objective" title={t("objectives.commodore.trail.open")} onClick={() => revealObjective({ objectiveId: group.objectiveId })}>{group.title}</button>
              <ul className="objectives-commodore-trail-entries">
                {group.entries.map((entry) => {
                  const body = (
                    <>
                      <span className="objectives-commodore-trail-line">
                        <span className={`objectives-commodore-trail-mark is-${entry.kind}`} aria-hidden="true" />
                        <span className="objectives-commodore-trail-word">{entry.word}</span>
                        <span className="objectives-commodore-trail-time">{when(entry.at)}</span>
                      </span>
                      {entry.detail ? <span className="objectives-commodore-trail-detail">{entry.detail}</span> : null}
                      {entry.why ? <span className="objectives-commodore-trail-why">{entry.why}</span> : null}
                    </>
                  );
                  return (
                    <li key={entry.key}>
                      {onReveal
                        ? <button type="button" className="objectives-commodore-trail-entry" title={t("objectives.commodore.trail.reveal")} onClick={() => onReveal(entry.at)}>{body}</button>
                        : <div className="objectives-commodore-trail-entry">{body}</div>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
