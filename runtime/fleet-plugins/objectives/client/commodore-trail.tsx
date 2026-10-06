import { useMemo, useLayoutEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { Objective, ObjectiveActor } from "../server/types.js";
import { objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";
import { revealObjective, useObjectiveTheater } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관이 목표에서 한 일 — 기록 곁 칸. 원천은 보드다: 목표마다 남는 행위 기록 중 행위자가 사령관인 것, 사령관이 대신 답한 결정,
 * 사령관이 만든 목표. 줄은 글리프·낱말·시각만 남고, 질문·답·이유는 툴팁과 기록 턴으로 간다.
 * 묶음은 마지막 활동이 오랜 것이 위, 줄도 오랜 것에서 최신으로. 스크롤은 바닥에서 시작하고, 바닥을 보는 중에만 새 줄을 따라간다.
 */

export type CommodoreTrailFamily = "progress" | "done" | "back" | "edit" | "added" | "decision";

export interface CommodoreTrailEntry {
  readonly key: string;
  readonly at: number;
  readonly family: CommodoreTrailFamily;
  readonly word: string;
  /** 결정 줄의 선택 라벨. 길면 말줄임. */
  readonly label?: string;
  /** 툴팁. 문단으로는 그리지 않는다. */
  readonly title: string;
}

export interface CommodoreTrailGroup {
  readonly objectiveId: string;
  readonly title: string;
  readonly done: boolean;
  readonly latest: number;
  readonly entries: readonly CommodoreTrailEntry[];
}

/** 한 목표에서 보이는 줄 수 — 그보다 오랜 것은 목표를 열어 본다. */
const ENTRIES_PER_OBJECTIVE = 4;
/** 바닥에서 이만큼 안이면 새 줄을 따라간다. */
const FOLLOW_SLACK_PX = 8;

const PROGRESS = new Set(["commence", "hand-off", "plan", "steer", "extend"]);
const DONE = new Set(["complete", "criteria-approved", "followup-selected"]);
const BACK = new Set(["reopen", "mission-reopened", "criteria-rejected", "followup-discarded"]);

/** 모르는 kind 는 편집(중립) 묶음으로 떨어진다. */
export function trailFamily(kind: string): CommodoreTrailFamily {
  if (PROGRESS.has(kind)) return "progress";
  if (DONE.has(kind)) return "done";
  if (BACK.has(kind)) return "back";
  if (kind === "added") return "added";
  if (kind === "decision") return "decision";
  return "edit";
}

const commodoreActor = (by: ObjectiveActor | undefined, theaterId: string): Extract<ObjectiveActor, { kind: "commodore" }> | null =>
  typeof by === "object" && by.kind === "commodore" && by.theaterId === theaterId ? by : null;

function actWord(t: T, kind: string): string {
  const key = `objectives.prov.act.${kind}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : kind;
}

function tooltip(parts: readonly (string | undefined)[], fallback: string): string {
  const text = parts.map((part) => part?.trim()).filter((part): part is string => !!part).join("\n");
  return text || fallback;
}

export function commodoreTrail(t: T, theaterId: string, objectives: readonly Objective[]): readonly CommodoreTrailGroup[] {
  const reveal = t("objectives.commodore.trail.reveal");
  const decisionWord = t("objectives.commodore.trail.decision");
  const groups: CommodoreTrailGroup[] = [];
  for (const objective of objectives) {
    const entries: CommodoreTrailEntry[] = [];
    const added = objective.addedBy && "kind" in objective.addedBy && objective.addedBy.theaterId === theaterId ? objective.addedBy : null;
    if (added) {
      entries.push({
        key: `${objective.id}:added`,
        at: objective.createdAt,
        family: "added",
        word: t("objectives.prov.addedByCommodore"),
        title: tooltip([added.why], reveal),
      });
    }
    for (const action of objective.actions ?? []) {
      const by = commodoreActor(action.by, theaterId);
      if (!by) continue;
      entries.push({
        key: action.id,
        at: action.at,
        family: trailFamily(action.kind),
        word: actWord(t, action.kind),
        title: tooltip([by.why], reveal),
      });
    }
    for (const decision of objective.decisions) {
      const by = commodoreActor(decision.by, theaterId);
      if (!by) continue;
      const chosen = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
      const answer = [...chosen, ...(decision.answer.text.trim() ? [decision.answer.text.trim()] : [])].join(", ");
      entries.push({
        key: decision.id,
        at: decision.at,
        family: "decision",
        word: decisionWord,
        ...(answer ? { label: answer } : {}),
        title: tooltip([decision.question.text, answer, by.why], reveal),
      });
    }
    if (entries.length === 0) continue;
    entries.sort((a, b) => a.at - b.at);
    const visible = entries.slice(-ENTRIES_PER_OBJECTIVE);
    groups.push({ objectiveId: objective.id, title: objective.title, done: objective.done !== null, latest: visible[visible.length - 1]!.at, entries: visible });
  }
  return groups.sort((a, b) => a.latest - b.latest);
}

const TIME_FORMATS = {
  en: { time: new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }), day: new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) },
  ko: { time: new Intl.DateTimeFormat("ko", { hour: "2-digit", minute: "2-digit" }), day: new Intl.DateTimeFormat("ko", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) },
};

/** 기록 칸(채팅 턴)과 같은 시각 표기 — 오늘이면 시각만, 아니면 날짜와 시각. */
function when(at: number, language: "en" | "ko"): string {
  const formats = TIME_FORMATS[language];
  return new Date(at).toDateString() === new Date().toDateString() ? formats.time.format(at) : formats.day.format(at);
}

function TrailGlyph({ family }: { readonly family: CommodoreTrailFamily }) {
  switch (family) {
    case "progress":
      return <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z" fill="currentColor" /></svg>;
    case "done":
      return <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.2 5.2 L4 8 L8.8 2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "back":
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M8.5 6.2 A3.6 3.6 0 1 1 6.6 1.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M5.2 0.4 L7.6 2 L5.6 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "added":
      return <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1 V9 M1 5 H9" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>;
    case "decision":
      return <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0.6 L9.4 5 L5 9.4 L0.6 5 Z" fill="currentColor" /></svg>;
    default:
      return <svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="2.7" fill="currentColor" /></svg>;
  }
}

export function CommodoreTrail({
  t,
  language,
  theaterId,
  width,
  onReveal,
}: {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly theaterId: string;
  readonly width?: number;
  readonly onReveal?: (at: number) => void;
}) {
  const { objectives } = useObjectiveTheater(theaterId);
  const groups = useMemo(() => commodoreTrail(t, theaterId, objectives), [t, theaterId, objectives]);
  const signature = groups.map((group) => `${group.objectiveId}:${group.entries.map((entry) => entry.key).join(",")}`).join("|");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [fresh, setFresh] = useState(false);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (stick.current) node.scrollTop = node.scrollHeight;
    setFresh(!stick.current);
  }, [signature]);
  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_SLACK_PX;
    stick.current = atBottom;
    if (atBottom) setFresh(false);
  };
  const jump = () => {
    const node = scrollRef.current;
    if (!node) return;
    stick.current = true;
    setFresh(false);
    node.scrollTop = node.scrollHeight;
  };
  return (
    <section className="objectives-commodore-trail" aria-label={t("objectives.commodore.trail.title")} style={width !== undefined ? { width } : undefined}>
      <h3 className="objectives-commodore-trail-title">{t("objectives.commodore.trail.title")}</h3>
      {groups.length === 0 ? <p className="objectives-commodore-trail-empty">{t("objectives.commodore.trail.empty")}</p> : (
        <>
          <div ref={scrollRef} className="objectives-commodore-trail-scroll" onScroll={onScroll}>
            <div className="objectives-commodore-trail-spacer" />
            <ul className="objectives-commodore-trail-list">
              {groups.map((group) => (
                <li key={group.objectiveId} className={`objectives-commodore-trail-group${group.done ? " is-done" : ""}`}>
                  <button type="button" className="objectives-commodore-trail-objective" title={t("objectives.commodore.trail.open")} onClick={() => revealObjective({ objectiveId: group.objectiveId })}>{group.title}</button>
                  <ul className="objectives-commodore-trail-entries">
                    {group.entries.map((entry) => {
                      const body = (
                        <>
                          <span className="objectives-commodore-trail-glyph" aria-hidden="true"><TrailGlyph family={entry.family} /></span>
                          <span className="objectives-commodore-trail-word">{entry.word}</span>
                          {entry.label ? (
                            <>
                              <span className="objectives-commodore-trail-dot" aria-hidden="true">·</span>
                              <span className="objectives-commodore-trail-label">{entry.label}</span>
                            </>
                          ) : null}
                          <span className="objectives-commodore-trail-time">{when(entry.at, language)}</span>
                        </>
                      );
                      return (
                        <li key={entry.key}>
                          {onReveal
                            ? <button type="button" className={`objectives-commodore-trail-entry is-${entry.family}`} title={entry.title} onClick={() => onReveal(entry.at)}>{body}</button>
                            : <div className={`objectives-commodore-trail-entry is-${entry.family}`} title={entry.title}>{body}</div>}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
          {fresh ? <button type="button" className="objectives-commodore-trail-fresh" onClick={jump}>{t("objectives.commodore.trail.new")}</button> : null}
        </>
      )}
    </section>
  );
}
