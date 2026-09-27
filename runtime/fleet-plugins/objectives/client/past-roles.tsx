/**
 * 지난 역할 — 이 Theater 의 다른 목표에서 구성원이 맡았던 역할과 그 사실(쓰인 목표·임무·인계 평가). 명단 아래에 선다.
 * 명단이 비어 있으면 지휘관이 구성원을 제안할 때 같은 목록(숨긴 역할 제외)을 읽는다. 사람은 여기서 역할을 구성원으로
 * 더하거나, 숨기거나, 다른 역할에 합친다 — 정리는 Theater 에 남고 다음 구상부터 지휘관이 본다.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Translate } from "@fleet-console/sdk/i18n";

import { pastRoles, resolveRole, type PastRole, type RoleCurateInput } from "../server/roles.js";
import type { Objective } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { useObjectiveTheater } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;
type Call = <R,>(path: string, body: Record<string, unknown>) => Promise<R | null>;

/** 처음에 보이는 줄 수 — 나머지는 「모두 보기」. */
const FIRST = 6;

const PlusGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>;
const MoreGlyph = () => <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>;
const ChevronGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>;

export function PastRoles({ objective, t, call, touchable }: { readonly objective: Objective; readonly t: T; readonly call: Call; readonly touchable: boolean }) {
  const theater = useObjectiveTheater(objective.theaterId);
  const roles = pastRoles(theater.objectives, theater.roles, { exclude: objective.id, includeHidden: true });
  const empty = objective.members.length === 0;
  const [open, setOpen] = useState(empty);
  const [all, setAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  // 명단이 비면 다시 펼친다 — 지휘관이 이 목록을 읽는 때와 사람이 보는 때를 맞춘다.
  useEffect(() => { if (empty) setOpen(true); }, [empty]);
  if (roles.length === 0) return null;
  const shown = roles.filter((role) => !role.hidden);
  const hidden = roles.filter((role) => role.hidden);
  const curate = (action: RoleCurateInput) => void call("/roles/curate", { theaterId: objective.theaterId, action });
  const add = (role: string) => void call("/member/add", { objectiveId: objective.id, member: { role } });
  // 사람이 합친 이름만 떼어 낼 수 있다 — 평가의 as 로 묶인 이름은 지휘관의 판단이라 여기서 풀지 않는다.
  const mergedInto = (role: string) => Object.keys(theater.roles.merged).filter((from) => from !== role && resolveRole(theater.roles, from) === role);
  const row = (role: PastRole) => <PastRoleRow key={role.role} role={role} t={t} touchable={touchable} merged={mergedInto(role.role)} targets={shown.filter((other) => other.role !== role.role).map((other) => other.role)} onAdd={add} onCurate={curate} />;
  return (
    <div className="objectives-past">
      <button type="button" className={`objectives-past-head${open ? " is-open" : ""}`} aria-expanded={open} aria-controls={`objectives-past-${objective.id}`} title={t("objectives.pastRoles.hint")} onClick={() => setOpen((value) => !value)}>
        <span className="objectives-past-chev"><ChevronGlyph /></span>
        <span>{t("objectives.pastRoles.title")}</span>
        <span className="objectives-past-count">{shown.length}</span>
      </button>
      <div id={`objectives-past-${objective.id}`} hidden={!open}>
        {(all ? shown : shown.slice(0, FIRST)).map(row)}
        {shown.length > FIRST || hidden.length ? (
          <div className="objectives-past-foot">
            {shown.length > FIRST ? <button type="button" className="objectives-past-link" onClick={() => setAll((value) => !value)}>{all ? t("objectives.pastRoles.less") : t("objectives.pastRoles.all", { count: shown.length })}</button> : null}
            {hidden.length ? <button type="button" className="objectives-past-link" aria-expanded={showHidden} onClick={() => setShowHidden((value) => !value)}>{t("objectives.pastRoles.hidden", { count: hidden.length })}</button> : null}
          </div>
        ) : null}
        {showHidden ? hidden.map(row) : null}
      </div>
    </div>
  );
}

function PastRoleRow({ role, t, touchable, merged, targets, onAdd, onCurate }: { readonly role: PastRole; readonly t: T; readonly touchable: boolean; readonly merged: readonly string[]; readonly targets: readonly string[]; readonly onAdd: (role: string) => void; readonly onCurate: (action: RoleCurateInput) => void }) {
  const latest = role.notes[0];
  const notes = role.notes.map((entry) => `${t(entry.rating === "well" ? "objectives.retro.well" : "objectives.retro.short")} · ${entry.note}`).join("\n");
  return (
    <div className={`objectives-past-row${role.hidden ? " is-hidden" : ""}`}>
      <span className="objectives-member-mark is-past" aria-hidden="true">{Array.from(role.role)[0] ?? "?"}</span>
      <span className="objectives-past-name">
        <span className="objectives-past-role">{role.role}</span>
        {role.aliases.length ? <span className="objectives-past-aliases" title={role.aliases.join(", ")}>{t("objectives.pastRoles.aliases", { names: role.aliases.join(", ") })}</span> : null}
      </span>
      {/* 사실 한 칸은 줄바꿈하지 않는다 — 좁은 폭에서는 칸과 칸 사이(· 앞)에서만 넘어간다. */}
      <span className="objectives-past-facts">
        <span>{t("objectives.pastRoles.objectives", { count: role.objectives })}</span>
        <span>{` · ${t("objectives.pastRoles.missions", { done: role.missions.done, assigned: role.missions.assigned })}`}</span>
        {role.maxParallel > 1 ? <span>{` · ${t("objectives.pastRoles.parallel", { count: role.maxParallel })}`}</span> : null}
        {role.well ? <span className="objectives-past-well">{` · ${t("objectives.pastRoles.well", { count: role.well })}`}</span> : null}
        {role.short ? <span className="objectives-past-short">{` · ${t("objectives.pastRoles.short", { count: role.short })}`}</span> : null}
      </span>
      {touchable ? (
        <span className="objectives-past-actions">
          {role.hidden ? null : <button type="button" className="objectives-glyph objectives-past-add" title={t("objectives.pastRoles.add")} aria-label={t("objectives.pastRoles.addAria", { role: role.role })} onClick={() => onAdd(role.role)}><PlusGlyph /></button>}
          <RoleMenu role={role} t={t} merged={merged} targets={targets} onCurate={onCurate} />
        </span>
      ) : null}
      {latest ? <span className={`objectives-past-note is-${latest.rating}`} title={notes}>{latest.note}</span> : null}
    </div>
  );
}

function RoleMenu({ role, t, merged, targets, onCurate }: { readonly role: PastRole; readonly t: T; readonly merged: readonly string[]; readonly targets: readonly string[]; readonly onCurate: (action: RoleCurateInput) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -1000, top: -1000 });
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", down, true); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 200;
    setPos({ left: Math.max(12, Math.min(rect.right - 216, window.innerWidth - 228)), top: rect.bottom + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 6) : rect.bottom + 6 });
  }, [open]);
  const pick = (action: RoleCurateInput) => { onCurate(action); setOpen(false); };
  const label = t("objectives.pastRoles.menu", { role: role.role });
  return <>
    <button ref={trigger} type="button" className="objectives-glyph objectives-past-more" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((value) => !value)}><MoreGlyph /></button>
    {open ? createPortal(<div ref={menu} className="objectives-menu objectives-past-menu" role="menu" aria-label={label} style={{ ...pos, width: 216 }}>
      <button type="button" role="menuitem" className="objectives-menu-item" onClick={() => pick({ kind: role.hidden ? "show" : "hide", role: role.role })}><span className="objectives-menu-label">{t(role.hidden ? "objectives.pastRoles.show" : "objectives.pastRoles.hide")}</span></button>
      {merged.map((name) => <button key={name} type="button" role="menuitem" className="objectives-menu-item" onClick={() => pick({ kind: "unmerge", role: name })}><span className="objectives-menu-label">{t("objectives.pastRoles.unmerge", { role: name })}</span></button>)}
      {targets.length && !role.hidden ? <>
        <div className="objectives-menu-divider" role="separator" />
        <p className="objectives-menu-caption objectives-assign-caption">{t("objectives.pastRoles.mergeInto")}</p>
        {targets.map((target) => <button key={target} type="button" role="menuitem" className="objectives-menu-item" onClick={() => pick({ kind: "merge", role: role.role, into: target })}><span className="objectives-menu-label">{target}</span></button>)}
      </> : null}
    </div>, document.body) : null}
  </>;
}
