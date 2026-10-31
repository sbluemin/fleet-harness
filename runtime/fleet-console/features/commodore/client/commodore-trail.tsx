import { useId, useMemo, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { Translate } from "@fleet-console/i18n";

import type { CommodoreBoardObjective as Objective, CommodoreBoardActor as ObjectiveActor } from "../../objectives/shared/commodore-board-client.js";
import { commodoreEn, type CommodoreMessageKey } from "./i18n/index.js";
import { revealObjective, useObjectiveTheater } from "./board.js";

type T = Translate<CommodoreMessageKey>;

/**
 * 사령관이 목표에서 한 일 — 기록 곁 칸. 원천은 보드다: 목표마다 남는 행위 기록 중 행위자가 사령관인 것, 사령관이 대신 답한 결정,
 * 사령관이 만든 목표. 줄은 글리프·낱말·시각만 남고, 질문·답·이유는 툴팁과 기록 턴으로 간다.
 * 묶음은 마지막 활동이 오랜 것이 위, 줄도 오랜 것에서 최신으로. 스크롤은 바닥에서 시작하고, 바닥을 보는 중에는 서랍 높이·내용 크기가 바뀌어도 바닥에 붙는다.
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
  typeof by === "object" && by.kind === "commodore" && by.commodoreId === theaterId ? by : null;

function actWord(t: T, kind: string): string {
  const key = `commodore.board.prov.act.${kind}`;
  return key in commodoreEn ? t(key as CommodoreMessageKey) : kind;
}

function tooltip(parts: readonly (string | undefined)[], fallback: string): string {
  const text = parts.map((part) => part?.trim()).filter((part): part is string => !!part).join("\n");
  return text || fallback;
}

export function commodoreTrail(t: T, theaterId: string, objectives: readonly Objective[]): readonly CommodoreTrailGroup[] {
  const reveal = t("commodore.trail.reveal");
  const decisionWord = t("commodore.trail.decision");
  const groups: CommodoreTrailGroup[] = [];
  for (const objective of objectives) {
    const entries: CommodoreTrailEntry[] = [];
    const added = objective.addedBy && "kind" in objective.addedBy && objective.addedBy.commodoreId === theaterId ? objective.addedBy : null;
    if (added) {
      entries.push({
        key: `${objective.id}:added`,
        at: objective.createdAt,
        family: "added",
        word: t("commodore.board.prov.addedByCommodore"),
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

const DAY_FORMATS = {
  en: new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }),
  ko: new Intl.DateTimeFormat("ko", { month: "short", day: "numeric" }),
};

/** 한 줄 목록의 좁은 시각 — 오늘이면 시각, 아니면 날짜만. */
function whenShort(at: number, language: "en" | "ko"): string {
  return new Date(at).toDateString() === new Date().toDateString() ? TIME_FORMATS[language].time.format(at) : DAY_FORMATS[language].format(at);
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
  onOpenObjective,
}: {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly theaterId: string;
  readonly width?: number;
  readonly onReveal?: (at: number) => void;
  /** 목표 제목을 눌렀을 때 — 생략하면 열린 목표 표면이 그 목표를 가리키게(reveal)만 한다. 폰은 그 목표의 대화 「목표」 탭으로 간다. */
  readonly onOpenObjective?: (objectiveId: string) => void;
}) {
  const { objectives } = useObjectiveTheater(theaterId);
  const groups = useMemo(() => commodoreTrail(t, theaterId, objectives), [t, theaterId, objectives]);
  const signature = groups.map((group) => `${group.objectiveId}:${group.entries.map((entry) => entry.key).join(",")}`).join("|");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const stick = useRef(true);
  const last = useRef({ top: 0, height: 0 });
  const [fresh, setFresh] = useState(false);
  // 첫 측정은 서랍이 자리 잡기 전이라 칸이 더 높다. 그때 바닥에 붙이면 스크롤이 잘리고, 높이가 줄어도 효과가 다시 돌지 않는다.
  // 칸과 목록의 크기가 바뀌는 동안 바닥을 보고 있으면 다시 붙인다. 위로 올려 읽는 중에는 자리를 지킨다.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const list = listRef.current;
    if (!scroll) return;
    const pin = () => {
      if (!stick.current) return;
      scroll.scrollTop = scroll.scrollHeight;
      last.current = { top: scroll.scrollTop, height: scroll.scrollHeight };
    };
    pin();
    setFresh(!stick.current);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    observer.observe(scroll);
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [signature]);
  // 칸이 줄거나 내용이 늘면 스크롤 이벤트가 크기 관찰보다 먼저 와 바닥에서 떨어져 보인다. 사람이 위로 올린 것만 따라가기를 푼다:
  // 내용 높이가 그대로인데 scrollTop 이 줄었을 때.
  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_SLACK_PX;
    const scrolledUp = node.scrollTop < last.current.top && node.scrollHeight === last.current.height;
    last.current = { top: node.scrollTop, height: node.scrollHeight };
    if (atBottom) {
      stick.current = true;
      setFresh(false);
    } else if (scrolledUp) {
      stick.current = false;
    }
  };
  const jump = () => {
    const node = scrollRef.current;
    if (!node) return;
    stick.current = true;
    setFresh(false);
    node.scrollTop = node.scrollHeight;
  };
  return (
    <section className="objectives-commodore-trail" aria-label={t("commodore.trail.title")} style={width !== undefined ? { width } : undefined}>
      <h3 className="objectives-commodore-trail-title objectives-commodore-panel-title">{t("commodore.trail.title")}</h3>
      {groups.length === 0 ? <p className="objectives-commodore-trail-empty">{t("commodore.trail.empty")}</p> : (
        <>
          <div ref={scrollRef} className="objectives-commodore-trail-scroll" onScroll={onScroll}>
            <div className="objectives-commodore-trail-spacer" />
            <ul ref={listRef} className="objectives-commodore-trail-list">
              {groups.map((group) => (
                <li key={group.objectiveId} className={`objectives-commodore-trail-group${group.done ? " is-done" : ""}`}>
                  <button type="button" className="objectives-commodore-trail-objective" title={t("commodore.trail.open")} onClick={() => { if (onOpenObjective) onOpenObjective(group.objectiveId); else revealObjective({ objectiveId: group.objectiveId }); }}>{group.title}</button>
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
          {fresh ? <button type="button" className="objectives-commodore-trail-fresh" onClick={jump}>{t("commodore.trail.new")}</button> : null}
        </>
      )}
    </section>
  );
}

/** 정보 탭 「목표 기록」이 처음 보이는 목표 수 — 나머지는 「더 보기」로 같은 자리에 펼친다. */
const SECTION_ROWS = 5;
/** 펼침 높이 전환과 같은 길이 — 전환이 끝났다는 이벤트가 오지 않아도 이 뒤에 높이를 풀어 준다. */
const SECTION_MOTION_MS = 320;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 높이를 고정한 상자를 목표 높이로 옮긴 뒤 풀어 준다. 동작 줄이기면 바로 끝낸다. `hold` 면 끝나도 높이를 쥔 채 `done` 만 부른다 —
 * 접기처럼 행을 줄인 렌더가 커밋된 뒤에 풀어야 펼친 높이가 한 프레임 튀지 않는다.
 */
function slideHeight(box: HTMLElement, from: number, to: number, done?: () => void, hold = false): void {
  if (reducedMotion() || from === to) { if (hold) box.style.height = `${to}px`; else box.style.height = ""; done?.(); return; }
  box.style.height = `${from}px`;
  void box.offsetHeight;
  box.style.height = `${to}px`;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    box.removeEventListener("transitionend", onEnd);
    if (!hold) box.style.height = "";
    done?.();
  };
  const onEnd = (event: TransitionEvent) => { if (event.target === box) finish(); };
  box.addEventListener("transitionend", onEnd);
  window.setTimeout(finish, SECTION_MOTION_MS + 80);
}

function TrailSectionRow({ t, language, group, open, onToggle, onReveal, onOpenObjective, rowRef, style }: {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly group: CommodoreTrailGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onReveal?: (at: number) => void;
  readonly onOpenObjective?: (objectiveId: string) => void;
  readonly rowRef?: (node: HTMLButtonElement | null) => void;
  readonly style?: CSSProperties;
}) {
  const foldId = useId();
  const last = group.entries[group.entries.length - 1]!;
  return (
    <li className={`objectives-commodore-trail-row-item${group.done ? " is-done" : ""}${style ? " is-revealed" : ""}`} style={style}>
      <button ref={rowRef} type="button" className="objectives-commodore-trail-row" aria-expanded={open} aria-controls={foldId} onClick={onToggle}>
        <span className={`objectives-commodore-trail-glyph is-${last.family}`} aria-hidden="true"><TrailGlyph family={last.family} /></span>
        <span className="objectives-commodore-trail-row-title">{group.title}</span>
        <span className="objectives-commodore-trail-row-last">{last.word} · {whenShort(last.at, language)}</span>
        <span className="objectives-commodore-trail-row-chev" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M3.5 1.8 L6.7 5 L3.5 8.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      </button>
      <div id={foldId} className={`objectives-commodore-trail-fold${open ? " is-open" : ""}`} inert={!open}>
        <div className="objectives-commodore-trail-fold-body">
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
          <button type="button" className="objectives-commodore-trail-row-open" onClick={() => { if (onOpenObjective) onOpenObjective(group.objectiveId); else revealObjective({ objectiveId: group.objectiveId }); }}>{t("commodore.trail.open")}</button>
        </div>
      </div>
    </li>
  );
}

/**
 * 정보 탭의 「목표 기록」 — 기억 아래 섹션. 최근에 움직인 목표가 위로, 목표마다 한 줄(마지막 행위·시각)이고, 행을 누르면 그 목표의
 * 최근 행위가 펼쳐진다(줄 = 채팅의 그 턴, 「목표 열기」 = 그 목표). 처음엔 최근 목표 몇 개만 서고 「더 보기」가 나머지를 같은 자리에
 * 펼친다. 높이는 미끄러지듯 바뀌고, 동작 줄이기면 바로 바뀐다. 폰 정보 화면도 같은 섹션을 쓴다(`phone`).
 */
export function CommodoreTrailSection({ t, language, theaterId, phone = false, onReveal, onOpenObjective }: {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly theaterId: string;
  readonly phone?: boolean;
  readonly onReveal?: (at: number) => void;
  readonly onOpenObjective?: (objectiveId: string) => void;
}) {
  const { objectives } = useObjectiveTheater(theaterId);
  const groups = useMemo(() => [...commodoreTrail(t, theaterId, objectives)].reverse(), [t, theaterId, objectives]);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const [revealFrom, setRevealFrom] = useState<number | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const grow = useRef<{ readonly from: number; readonly focusId: string | null } | null>(null);
  const collapsing = useRef(false);
  const hiddenCount = Math.max(0, groups.length - SECTION_ROWS);
  const shown = all ? groups : groups.slice(0, SECTION_ROWS);

  // 「더 보기」 직후 — 늘어난 목록 높이로 미끄러지고, 처음 드러난 행으로 초점을 옮긴다. 접기 직후 — 쥐고 있던 높이를 칠하기 전에 푼다.
  useLayoutEffect(() => {
    const pending = grow.current;
    const box = boxRef.current;
    const list = listRef.current;
    if (!all && box && !pending) { box.style.height = ""; return; }
    if (!pending || !box || !list) return;
    grow.current = null;
    slideHeight(box, pending.from, list.offsetHeight);
    if (pending.focusId) rowRefs.current.get(pending.focusId)?.focus({ preventScroll: true });
  }, [all]);

  const showMore = () => {
    if (!boxRef.current) { setAll(true); return; }
    grow.current = { from: boxRef.current.offsetHeight, focusId: groups[SECTION_ROWS]?.objectiveId ?? null };
    setRevealFrom(SECTION_ROWS);
    setAll(true);
  };
  const showLess = () => {
    const box = boxRef.current;
    const list = listRef.current;
    const cut = list?.children[SECTION_ROWS] as HTMLElement | undefined;
    if (collapsing.current) return;
    const end = () => {
      collapsing.current = false;
      setAll(false);
      setRevealFrom(null);
      // 펼친 행 가운데 접혀 사라지는 것은 닫는다 — 다시 펼쳤을 때 열린 채로 튀어나오지 않는다.
      setOpenIds((current) => new Set([...current].filter((id) => groups.slice(0, SECTION_ROWS).some((group) => group.objectiveId === id))));
      const section = sectionRef.current;
      if (section) section.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    };
    if (!box || !list || !cut) { end(); return; }
    collapsing.current = true;
    slideHeight(box, box.offsetHeight, cut.offsetTop - list.offsetTop, end, true);
  };
  const toggle = (objectiveId: string) => setOpenIds((current) => {
    const next = new Set(current);
    if (next.has(objectiveId)) next.delete(objectiveId); else next.add(objectiveId);
    return next;
  });

  return (
    <section ref={sectionRef} className={`objectives-commodore-section objectives-commodore-panel-section objectives-commodore-trail-section${phone ? " is-phone" : ""}`} aria-label={t("commodore.trail.section")}>
      <div className="objectives-commodore-panel-head">
        <h3 className="objectives-commodore-panel-title">{t("commodore.trail.section")}</h3>
        {groups.length > 0 ? <span className="objectives-commodore-panel-meta">{t("commodore.trail.count", { n: groups.length })}</span> : null}
      </div>
      {groups.length === 0 ? <p className="objectives-commodore-trail-empty">{t("commodore.trail.empty")}</p> : (
        <>
          <div ref={boxRef} className="objectives-commodore-trail-box">
            <ul ref={listRef} className="objectives-commodore-trail-rows">
              {shown.map((group, index) => (
                <TrailSectionRow
                  key={group.objectiveId}
                  t={t}
                  language={language}
                  group={group}
                  open={openIds.has(group.objectiveId)}
                  onToggle={() => toggle(group.objectiveId)}
                  onReveal={onReveal}
                  onOpenObjective={onOpenObjective}
                  rowRef={(node) => { if (node) rowRefs.current.set(group.objectiveId, node); else rowRefs.current.delete(group.objectiveId); }}
                  style={revealFrom !== null && index >= revealFrom ? { animationDelay: `${Math.min(index - revealFrom, 8) * 30}ms` } : undefined}
                />
              ))}
            </ul>
          </div>
          {hiddenCount > 0 ? (
            <button type="button" className="objectives-commodore-trail-more" aria-expanded={all} onClick={all ? showLess : showMore}>
              {all ? t("commodore.trail.less") : t("commodore.trail.more", { n: hiddenCount })}
              <span className="objectives-commodore-trail-more-chev" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M1.8 3.5 L5 6.7 L8.2 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
