import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import { StatusGlyph, type StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";

import type { Objective } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import type { ObjectiveGroup } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 제목 ⌄ 전환 목록 — 사이드바가 접혀 있거나(Zen·War Room·Cruise 접힘) 모바일일 때 표면이 사이드바 그룹 트리를 대신한다.
 * 같은 트리를 같은 규칙으로 그린다: 「결정 요청」(요청 시각순)·「오늘」(오늘 + 기한 지남) 구역이 먼저 서고, 올라간 목표는 그룹에서
 * 빠진다. 빈 구역은 세우지 않는다. 그룹 머리의 「+」가 그 그룹에 목표를 만든다. Esc 나 바깥 누름으로 닫힌다.
 */

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const overdueOf = (objective: Objective) => !!objective.dueDate && objective.dueDate < todayIso();

export interface SwitcherProps {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly objectives: readonly Objective[];
  readonly groups: readonly ObjectiveGroup[];
  readonly selected: string | null;
  readonly glyphOf: (objective: Objective) => { readonly state: StatusGlyphState; readonly label: string };
  readonly onPick: (objectiveId: string) => void;
  readonly onCreate: (groupId: string | null) => void;
}

export function ObjectiveSwitcher({ t, language, objectives, groups, selected, glyphOf, onPick, onCreate }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onPointer, true); };
  }, [open]);

  const live = objectives.filter((objective) => objective.enlisted && !objective.removed && !objective.done);
  const decisions = live.filter((objective) => !!objective.decisionRequest)
    .sort((a, b) => (a.decisionRequest?.createdAt ?? 0) - (b.decisionRequest?.createdAt ?? 0));
  const today = live.filter((objective) => !objective.decisionRequest && (objective.today || overdueOf(objective)));
  const promoted = new Set([...decisions, ...today].map((objective) => objective.id));
  const known = new Set(groups.map((group) => group.id));
  const rest = live.filter((objective) => !promoted.has(objective.id));
  const day = new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short" });
  const groupOf = (objective: Objective) => (objective.groupId ? groups.find((group) => group.id === objective.groupId) ?? null : null);
  const pick = (objectiveId: string) => { setOpen(false); onPick(objectiveId); };
  const create = (groupId: string | null) => { setOpen(false); onCreate(groupId); };

  const row = (objective: Objective, dot: boolean) => {
    const glyph = glyphOf(objective);
    const meta: { readonly key: string; readonly text: string; readonly tone?: string }[] = [];
    if (objective.decisionRequest) meta.push({ key: "req", text: t("objectives.switch.decisionCount", { count: objective.decisionRequest.questions.length || 1 }), tone: "req" });
    if (objective.missions.length) meta.push({ key: "progress", text: `✓ ${objective.missions.filter((mission) => mission.done).length}/${objective.missions.length}` });
    if (objective.dueDate) meta.push({ key: "due", text: day.format(new Date(`${objective.dueDate}T00:00:00`)), ...(overdueOf(objective) ? { tone: "late" } : {}) });
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
    const addLabel = group ? t("objectives.switch.addTo", { name: group.name }) : t("objectives.switch.add");
    return (
      <li key={group?.id ?? "ungrouped"} className="objectives-pop-group">
        <div className="objectives-pop-group-hd">
          {group ? <span className="objectives-swatch" style={{ background: `var(--id-${group.color}, var(--text-tertiary))` }} aria-hidden="true" /> : null}
          <span className="objectives-pop-group-name">{name}</span>
          <span className="objectives-pop-count">{items.length}</span>
          <button type="button" className="objectives-pop-add" aria-label={addLabel} title={addLabel} onClick={() => create(group?.id ?? null)}>+</button>
        </div>
        {items.length ? <ol>{items.map((objective) => row(objective, false))}</ol> : null}
      </li>
    );
  };
  const ungrouped = rest.filter((objective) => !objective.groupId || !known.has(objective.groupId));

  return (
    <span ref={wrapRef} className="objectives-switch-wrap">
      <button ref={buttonRef} type="button" className="objectives-switch" aria-haspopup="true" aria-expanded={open} aria-label={t("objectives.switch.label")} title={t("objectives.switch.label")} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>
      </button>
      {open ? (
        <div className="objectives-pop" role="dialog" aria-label={t("objectives.switch.label")}>
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
