import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import { StatusGlyph, type StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";

import type { Objective } from "../server/types.js";
import { originTitleOf } from "./clusters.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import type { ObjectiveGroup } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 제목 ⌄ 전환 목록 — 사이드바가 접혀 있거나(Zen·War Room·Cruise 접힘) 모바일일 때 표면이 사이드바 그룹 트리를 대신한다.
 * 같은 트리를 같은 규칙으로 그린다: 「결정 요청」(요청 시각순)·「오늘」(오늘 + 기한 지남) 구역이 먼저 서고, 올라간 목표는 그룹에서
 * 빠진다. 빈 구역은 세우지 않는다. 시작 전 목표는 그룹 맨 아래 「시작 전 N ›」 한 줄로 접힌다 — 펼침은 그룹별로 이 탭의 메모리에만
 * 둔다(사이드바의 접기와 같은 규칙, 번들이 달라 상태는 따로). 고른 목표가 접기 안에 있으면 열 때 그 접기를 펼쳐 둔다.
 * 사람이 세션 없는 목표를 만드는 입구는 없다 — 목표는 「새 Operation」에서 시작한다. Esc 나 바깥 누름으로 닫힌다.
 * 열림은 표면이 쥔다 — 빈 상태의 「목표 목록 열기」도 같은 목록을 연다. 그 입구(`data-objectives-switch-opener`)로 열면 초점이
 * 목록 안으로 들어가고, Esc 는 초점을 연 입구로 돌려보낸다.
 */

/** 그룹별 「시작 전」 펼침 — `${theaterId}:${groupId}`. 새로 고침하면 모두 접힌다. */
const foldOpen = new Map<string, boolean>();
const foldKey = (theaterId: string, groupId: string | null) => `${theaterId}:${groupId ?? ""}`;
/** 목록에서 고른 직후 — 상세가 새 목표로 다시 마운트돼도 새 ⌄ 가 초점을 받는다. 닫힌 목록의 줄과 함께 초점이 사라지지 않게. */
let refocusTrigger = false;

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const overdueOf = (objective: Objective) => !!objective.dueDate && objective.dueDate < todayIso();

export interface SwitcherProps {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly theaterId: string;
  readonly objectives: readonly Objective[];
  readonly groups: readonly ObjectiveGroup[];
  readonly selected: string | null;
  readonly glyphOf: (objective: Objective) => { readonly state: StatusGlyphState; readonly label: string };
  /** 지휘관 Operation 이 서 있는가 — 개시한 목표는 첫 턴 전이라도 접기에서 빠진다(사이드바의 뿌리 있는 줄과 같은 규칙). */
  readonly hasOperation: (objectiveId: string) => boolean;
  readonly onPick: (objectiveId: string) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ObjectiveSwitcher({ t, language, theaterId, objectives, groups, selected, glyphOf, hasOperation, onPick, open, onOpenChange: setOpen }: SwitcherProps) {
  const [, setFoldTick] = useState(0);
  const popRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      (openerRef.current?.isConnected ? openerRef.current : buttonRef.current)?.focus();
    };
    // 바깥 입구를 다시 누르면 입구가 닫는다 — 여기서 먼저 닫으면 같은 누름의 click 이 다시 연다.
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!wrapRef.current?.contains(target) && !target.closest?.("[data-objectives-switch-opener]")) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onPointer, true); };
  }, [open]);

  const live = objectives.filter((objective) => objective.enlisted && !objective.removed && !objective.done);
  const decisions = live.filter((objective) => !!objective.decisionRequest)
    .sort((a, b) => (a.decisionRequest?.createdAt ?? 0) - (b.decisionRequest?.createdAt ?? 0));
  const today = live.filter((objective) => !objective.decisionRequest && (objective.today || overdueOf(objective)));
  const promoted = new Set([...decisions, ...today].map((objective) => objective.id));
  const rest = live.filter((objective) => !promoted.has(objective.id));
  const day = new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short" });
  const groupOf = (objective: Objective) => (objective.groupId ? groups.find((group) => group.id === objective.groupId) ?? null : null);
  const pick = (objectiveId: string) => { setOpen(false); refocusTrigger = true; onPick(objectiveId); };
  useEffect(() => {
    if (!refocusTrigger) return;
    refocusTrigger = false;
    buttonRef.current?.focus();
  }, [selected]);
  const byId = new Map(objectives.map((objective) => [objective.id, objective]));
  const known = new Set(groups.map((group) => group.id));
  const sectionOf = (objective: Objective): string | null => (objective.groupId && known.has(objective.groupId) ? objective.groupId : null);
  const freshOf = (objective: Objective) => !objective.awaitingReview && !objective.commander.started && !hasOperation(objective.id);
  const toggleFold = (key: string) => { foldOpen.set(key, !foldOpen.get(key)); setFoldTick((tick) => tick + 1); };

  // 열 때: 고른 목표가 접기 안에 있으면 그 접기를 펼치고, 고른 줄이 보이게 스크롤한다.
  const selectedObjective = selected ? rest.find((objective) => objective.id === selected) : undefined;
  if (open && selectedObjective && freshOf(selectedObjective)) foldOpen.set(foldKey(theaterId, sectionOf(selectedObjective)), true);
  useLayoutEffect(() => {
    if (!open) return;
    const current = popRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    current?.scrollIntoView({ block: "nearest" });
    // 목록 밖 입구로 열었다 — 목록은 머리에 붙어 그 입구보다 앞에 서니 Tab 으로는 닿지 않는다. 초점을 목록 안으로 옮긴다.
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active.closest("[data-objectives-switch-opener]") ? active : null;
    if (openerRef.current) (current ?? popRef.current?.querySelector<HTMLElement>("button"))?.focus();
  }, [open]);

  const row = (objective: Objective, dot: boolean, from = false) => {
    const glyph = glyphOf(objective);
    const meta: { readonly key: string; readonly text: string; readonly tone?: string }[] = [];
    if (objective.decisionRequest) meta.push({ key: "req", text: t("objectives.switch.decisionCount", { count: objective.decisionRequest.questions.length || 1 }), tone: "req" });
    if (objective.missions.length) meta.push({ key: "progress", text: `✓ ${objective.missions.filter((mission) => mission.done).length}/${objective.missions.length}` });
    if (objective.dueDate) meta.push({ key: "due", text: day.format(new Date(`${objective.dueDate}T00:00:00`)), ...(overdueOf(objective) ? { tone: "late" } : {}) });
    const originTitle = from ? originTitleOf(objective, byId) : undefined;
    if (originTitle !== undefined) meta.push({ key: "from", text: originTitle ? t("objectives.switch.followupOf", { title: originTitle }) : t("objectives.switch.followup"), tone: "from" });
    const group = dot ? groupOf(objective) : null;
    return (
      <li key={objective.id}>
        <button type="button" className="objectives-pop-row" aria-current={selected === objective.id ? "true" : undefined}
          aria-label={[objective.title, glyph.label, ...meta.map((part) => part.text), group?.name ?? ""].filter(Boolean).join(", ")}
          onClick={() => pick(objective.id)}>
          <StatusGlyph state={glyph.state} label={glyph.label} decorative />
          <span className="objectives-pop-body" aria-hidden="true">
            <span className="objectives-pop-title">{objective.title}</span>
            {meta.length ? <span className="objectives-pop-meta">{meta.map((part) => <span key={part.key} className={part.tone ? `is-${part.tone}` : undefined}>{part.text}</span>)}</span> : null}
          </span>
          {group ? <span className="objectives-pop-dot" style={{ "--grp-color": `var(--id-${group.color}, var(--text-tertiary))` } as CSSProperties} title={group.name} aria-hidden="true" /> : <span aria-hidden="true" />}
        </button>
      </li>
    );
  };
  const zone = (kind: "decisions" | "today", items: readonly Objective[]) => (items.length ? (
    <li key={kind} className={`objectives-pop-zone is-${kind}`}>
      <div className="objectives-pop-zone-hd"><span>{t(kind === "decisions" ? "objectives.switch.decisions" : "objectives.switch.today")}</span><span className="objectives-pop-count">{items.length}</span></div>
      <ol>{items.map((objective) => row(objective, true))}</ol>
    </li>
  ) : null);
  const section = (group: ObjectiveGroup | null, items: readonly Objective[]) => {
    const name = group ? group.name : t("objectives.list.ungrouped");
    const shown = items.filter((objective) => !freshOf(objective));
    const fresh = items.filter(freshOf);
    const key = foldKey(theaterId, group?.id ?? null);
    const expanded = foldOpen.get(key) === true;
    return (
      <li key={group?.id ?? "ungrouped"} className="objectives-pop-group">
        <div className="objectives-pop-group-hd">
          {group ? <span className="objectives-swatch" style={{ background: `var(--id-${group.color}, var(--text-tertiary))` }} aria-hidden="true" /> : null}
          <span className="objectives-pop-group-name">{name}</span>
          <span className="objectives-pop-count">{items.length}</span>
        </div>
        {shown.length || fresh.length ? (
          <ol>
            {shown.map((objective) => row(objective, false))}
            {fresh.length ? (
              <li className="objectives-pop-fold-item">
                <button type="button" className="objectives-pop-fold" aria-expanded={expanded}
                  aria-label={`${t("objectives.switch.notStarted")} ${fresh.length}`} onClick={() => toggleFold(key)}
                  onKeyDown={(event) => { if (event.code === "Space") event.stopPropagation(); /* 캔버스 Space-pan이 기본 활성화를 막지 않게 */ }}>
                  <span className="objectives-pop-fold-rings" aria-hidden="true"><i /><i /><i /></span>
                  <span aria-hidden="true">{t("objectives.switch.notStarted")}</span>
                  <span className="objectives-pop-count" aria-hidden="true">{fresh.length}</span>
                  <span className="objectives-pop-fold-chev" aria-hidden="true">›</span>
                </button>
                {expanded ? <ol className="objectives-pop-fold-body">{fresh.map((objective) => row(objective, false, true))}</ol> : null}
              </li>
            ) : null}
          </ol>
        ) : null}
      </li>
    );
  };
  const ungrouped = rest.filter((objective) => sectionOf(objective) === null);

  return (
    <span ref={wrapRef} className="objectives-switch-wrap">
      <button ref={buttonRef} type="button" className="objectives-switch" aria-haspopup="true" aria-expanded={open} aria-label={t("objectives.switch.label")} title={t("objectives.switch.label")} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>
      </button>
      {open ? (
        <div ref={popRef} className="objectives-pop" role="dialog" aria-label={t("objectives.switch.label")}>
          <ul className="objectives-pop-tree">
            {zone("decisions", decisions)}
            {zone("today", today)}
            {groups.map((group) => section(group, rest.filter((objective) => objective.groupId === group.id)))}
            {section(null, ungrouped)}
          </ul>
          {live.length === 0 ? <p className="objectives-pop-empty">{t("objectives.switch.empty")}</p> : null}
        </div>
      ) : null}
    </span>
  );
}
