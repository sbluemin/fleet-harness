import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { Objective } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";

/**
 * 「정리됨」 — 에이전트가 Console Use 로 지우거나 합친 목표와 사람이 지운 기동 전 목표가 보관 기간 동안 서는 자리. 범위 낱말 하나가
 * 입구이고, 정리한 주체마다 소제목과 「모두 되돌리기」·「비우기」(두 번 누름)가 선다. 지운 목표의 상세는 읽기 전용이다.
 */

type T = Translate<ObjectiveMessageKey>;
type Call = <R,>(path: string, body: Record<string, unknown>) => Promise<R | null>;
type Language = "en" | "ko";

export const MergeGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v3.5a3 3 0 0 0 3 3h7" /><path d="M3 13V9.5" /><path d="M10.5 7l2.5 2.5-2.5 2.5" /></svg>;
const GoneGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeDasharray="2.2 2" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /></svg>;

const DAY = 86_400_000;
const ARM_MS = 4000;

/** 정리한 주체 — 에이전트 Operation 이거나 사람 자신. */
const actorKey = (objective: Objective): string => objective.removed?.by?.operationId ?? "person";
const actorName = (objective: Objective, t: T): string => objective.removed?.by ? objective.removed.by.title ?? t("objectives.tidied.byAgent") : t("objectives.tidied.byYou");
const daysLeft = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / DAY));

function ago(at: number, now: number, language: Language): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

/** 두 번 눌러 확정 — 첫 누름이 문구를 바꾸고, 잠시 뒤 풀린다. */
function useArm(): readonly [string | null, (key: string, fire: () => void) => void] {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const press = (key: string, fire: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    if (armed === key) { setArmed(null); fire(); return; }
    setArmed(key);
    timer.current = setTimeout(() => setArmed(null), ARM_MS);
  };
  return [armed, press];
}

const restoreAll = async (call: Call, objectives: readonly Objective[]) => { for (const objective of objectives) await call("/objective/restore", { objectiveId: objective.id }); };
const purgeAll = async (call: Call, objectives: readonly Objective[]) => { for (const objective of objectives) await call("/objective/remove", { objectiveId: objective.id }); };

/** 「정리됨」 범위의 목록 — 정리한 주체마다 한 묶음, 최근 정리가 위다. */
export function TidiedList({ objectives, t, language, selected, onSelect, call }: {
  readonly objectives: readonly Objective[];
  readonly t: T;
  readonly language: Language;
  readonly selected: string | null;
  readonly onSelect: (objectiveId: string) => void;
  readonly call: Call;
}) {
  const now = useNow();
  const [armed, arm] = useArm();
  const groups = new Map<string, Objective[]>();
  for (const objective of objectives) groups.set(actorKey(objective), [...(groups.get(actorKey(objective)) ?? []), objective]);
  const latest = (items: readonly Objective[]) => Math.max(...items.map((objective) => objective.removed!.at));
  const ordered = [...groups.entries()].sort((a, b) => latest(b[1]) - latest(a[1]));
  return (<>
    <p className="objectives-outside-hint">{t("objectives.tidied.hint")}</p>
    {objectives.length === 0 ? <div className="objectives-empty">{t("objectives.tidied.empty")}</div> : null}
    {ordered.map(([key, items]) => {
      const merged = items.filter((objective) => objective.removed!.mergedInto).length;
      return (
        <div key={key} className="objectives-section objectives-tidied-group">
          <div className="objectives-tidied-head">
            <span className="objectives-tidied-actor">{actorName(items[0]!, t)}</span>
            <span>{ago(latest(items), now, language)} · {t("objectives.tidied.counts", { merged, removed: items.length - merged })}</span>
            <button type="button" className="objectives-tidied-link is-undo" onClick={() => void restoreAll(call, items)}>{t("objectives.tidied.restoreAll")}</button>
            <button type="button" className={`objectives-tidied-link${armed === key ? " is-armed" : ""}`} onClick={() => arm(key, () => void purgeAll(call, items))}>{t(armed === key ? "objectives.tidied.emptyArmed" : "objectives.tidied.emptyBin")}</button>
          </div>
          {items.map((objective) => {
            const removed = objective.removed!;
            return (
              <div key={objective.id} data-objective-id={objective.id} className="objectives-objective is-tidied" role="option" aria-selected={selected === objective.id} tabIndex={0}
                onClick={() => onSelect(objective.id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(objective.id); } }}>
                <span className="objectives-objective-ring objectives-tidied-glyph" role="img" aria-label={t(removed.mergedInto ? "objectives.tidied.mergedKind" : "objectives.tidied.removedKind")}>{removed.mergedInto ? <MergeGlyph /> : <GoneGlyph />}</span>
                <div className="objectives-objective-title">{objective.title}</div>
                <div className="objectives-objective-meta">
                  <span className="objectives-tidied-kind">{removed.mergedInto ? t("objectives.tidied.mergedInto", { title: removed.mergedInto.title ?? "—" }) : t("objectives.tidied.removedKind")}</span>
                  <span>{actorName(objective, t)} · {ago(removed.at, now, language)}</span>
                  <span>{t("objectives.tidied.daysLeft", { days: daysLeft(removed.expiresAt, now) })}</span>
                  {removed.reason ? <span className="objectives-tidied-reason">{t("objectives.tidied.reason", { reason: removed.reason })}</span> : null}
                </div>
                <span className="objectives-objective-go"><button type="button" className="objectives-tidied-link is-undo" aria-label={t("objectives.tidied.restoreAria", { title: objective.title })} onClick={(event) => { event.stopPropagation(); void call("/objective/restore", { objectiveId: objective.id }); }}>{t("objectives.tidied.restore")}</button></span>
              </div>
            );
          })}
        </div>
      );
    })}
  </>);
}

/** 지우거나 합친 목표의 상세 — 읽기 전용. 누가·언제·이유와 되돌리기, 합쳤으면 받은 목표로 가는 길. */
export function TidiedDetail({ objective, t, language, call, back, onOpenObjective, detailRef, three, head }: {
  readonly objective: Objective;
  readonly t: T;
  readonly language: Language;
  readonly call: Call;
  /** 머리의 뒤로가기 — 세 칸에서 목록이 펼쳐져 있으면 없다. */
  readonly back: { readonly label: string; readonly onClick: () => void; readonly glyph?: ReactNode } | null;
  readonly onOpenObjective: (objectiveId: string) => void;
  readonly detailRef: RefObject<HTMLElement | null>;
  readonly three: boolean;
  readonly head?: ReactNode;
}) {
  const now = useNow();
  const removed = objective.removed!;
  const into = removed.mergedInto;
  const moved = into ? objective.criteria.length : 0;
  return (
    <aside ref={detailRef} className={`objectives-detail is-tidied${three ? " is-three" : ""}`} aria-label={objective.title}>
      <div className="objectives-detail-scroll">
        <div className="objectives-detail-pane is-content">
          <div className="objectives-group">
            <div className="objectives-detail-head">
              {back ? <button type="button" className={`objectives-glyph objectives-detail-back${back.glyph ? " is-unfold" : ""}`} aria-label={back.label} title={back.label} onClick={back.onClick}>{back.glyph ?? "‹"}</button> : null}
              <span className="objectives-objective-ring objectives-tidied-glyph" aria-hidden="true">{into ? <MergeGlyph /> : <GoneGlyph />}</span>
              <div className="objectives-detail-title is-tidied">{objective.title}</div>
              {head}
            </div>
          </div>
          <div className="objectives-group objectives-tidied-notice" role="status">
            <strong>{into ? t("objectives.tidied.noticeMerged", { title: into.title ?? "—" }) : t("objectives.tidied.noticeRemoved")}</strong>
            <span>{actorName(objective, t)} · {ago(removed.at, now, language)} · {t("objectives.tidied.expires", { days: daysLeft(removed.expiresAt, now) })}</span>
            {removed.reason ? <span>{t("objectives.tidied.reason", { reason: removed.reason })}</span> : null}
            <div className="objectives-tidied-actions">
              <button type="button" className="objectives-btn" onClick={() => void call("/objective/restore", { objectiveId: objective.id })}>{t("objectives.tidied.restore")}</button>
              {into ? <button type="button" className="objectives-tidied-link" onClick={() => onOpenObjective(into.id)}>{t("objectives.tidied.openTarget")}</button> : null}
            </div>
          </div>
          <div className="objectives-group">
            <span className="objectives-tidied-label">{t("objectives.objective.memo")}</span>
            <p className="objectives-tidied-brief">{objective.note ? <LinkText text={objective.note} /> : "—"}</p>
          </div>
          <div className="objectives-group">
            <span className="objectives-tidied-label">{t("objectives.criteria.title")}</span>
            {moved ? <p className="objectives-criterion-sub">{t("objectives.tidied.movedCriteria", { count: moved })}</p>
              : objective.criteria.length ? <ul className="objectives-tidied-criteria">{objective.criteria.map((criterion) => <li key={criterion.id}><LinkText text={criterion.text} /></li>)}</ul>
              : <p className="objectives-criterion-sub">—</p>}
          </div>
        </div>
        <div className="objectives-detail-pane is-ops" />
      </div>
    </aside>
  );
}

/** 받은 목표의 브리핑 아래 — 합쳐 온 목표마다 출처와 되돌리기. 원본이 보관 기간을 넘겼으면 되돌릴 수 없다고만 말한다. */
export function MergedTrail({ objective, t, language, call, onOpenObjective }: { readonly objective: Objective; readonly t: T; readonly language: Language; readonly call: Call; readonly onOpenObjective: (objectiveId: string) => void }) {
  const now = useNow();
  if (!objective.merged.length) return null;
  return (
    <div className="objectives-merged-trail">
      {objective.merged.map((entry) => (
        <div key={entry.sourceId} className="objectives-merged-entry">
          <span className="objectives-merged-src"><MergeGlyph />{entry.restorable
            ? <button type="button" className="objectives-tidied-link" onClick={() => onOpenObjective(entry.sourceId)}>{t("objectives.tidied.mergedFrom", { title: entry.title })}</button>
            : <span>{t("objectives.tidied.mergedFrom", { title: entry.title })}</span>}</span>
          <span>{entry.by.title ?? t("objectives.tidied.byAgent")} · {ago(entry.at, now, language)}</span>
          {entry.restorable
            ? <button type="button" className="objectives-tidied-link is-undo" aria-label={t("objectives.tidied.restoreAria", { title: entry.title })} onClick={() => void call("/objective/restore", { objectiveId: entry.sourceId })}>{t("objectives.tidied.restore")}</button>
            : <span>{t("objectives.tidied.sourceGone")}</span>}
        </div>
      ))}
    </div>
  );
}

/** 옮겨 온 기준의 원본 제목 — 기준 id → 합쳐 온 목표의 제목. */
export const criterionSources = (objective: Objective): ReadonlyMap<string, string> => new Map(objective.merged.flatMap((entry) => entry.criteriaIds.map((id) => [id, entry.title] as const)));
