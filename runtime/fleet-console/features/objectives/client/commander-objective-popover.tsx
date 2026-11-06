import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ObjectiveResult } from "../shared/types.js";
import { getT } from "./i18n/index.js";
import { DatePicker } from "./date-picker.js";
import { LaunchControl } from "./launch-control.js";
import { openResultWindow } from "./result-window.js";
import { relative, useNow } from "./result-content.js";
import { CalGlyph, dueLabel, todayIso } from "./objectives-panel.js";
import { loadBoard, objectiveRecordSummaries, objectivesApi, post, subscribeObjective, useObjectiveBoard } from "./objectives-state.js";

/** 팝업 폭과 앵커(행)와의 간격 — 행 왼쪽(가운데 칸 위)에 선다. 왼쪽 자리가 모자라면 행 아래에 선다. */
const POPOVER_WIDTH = 300;
const POPOVER_GAP = 8;
const EDGE = 8;
const RECENT_RESULTS = 3;

/**
 * 우측 작업 탭의 목표 팝업 — 행이나 아바타를 누르면 연다(행 펼침을 대신한다). 사람이 고른 구성 그대로다:
 * 지금 상태 · 사람 차례 · 진척 · 달성 기준 목록 · 기한(여기서 바꾼다) · 최근 결과물 · 지휘관, 그리고 「대화 열기」.
 * 행 쪽 사실(상태 문구·도구 사용·아바타)은 목록이 넘기고, 목표 사실은 보드에서 읽어 변경이 바로 보인다.
 * Esc·바깥 누름으로 닫히고 닫힌 뒤 연 단추로 초점이 돌아간다. 날짜 선택기·결과물 창 안의 누름은 바깥으로 치지 않는다.
 */
export function CommanderObjectivePopover({ commodoreId, objectiveId, anchor, language, avatar, activityAt, statusLine, toolLabel, onOpenConversation, onReview, onClose }: {
  readonly commodoreId: string;
  readonly objectiveId: string;
  /** 위치를 잡는 행 — 아바타로 열어도 행 전체를 기준으로 선다. */
  readonly anchor: HTMLElement;
  readonly language: "en" | "ko";
  readonly avatar: ReactNode;
  /** 행의 마지막 활동 시각 — 머리 밑줄에 상대 시각으로 선다. */
  readonly activityAt: number | null;
  /** 행 둘째 줄과 같은 상태 문구 — 「지금」 칸. */
  readonly statusLine: string;
  readonly toolLabel: string | null;
  readonly onOpenConversation: () => void;
  /** 검토 대기 목표의 검토 — 행의 검토 동작이 없으면 대화를 연다. */
  readonly onReview: (() => void) | null;
  /** 닫기 — `restoreFocus` 면 연 단추로 초점을 돌린다(Esc·닫기). 바깥 누름은 누른 자리에 초점을 둔다. */
  readonly onClose: (restoreFocus: boolean) => void;
}) {
  const t = getT(language);
  const board = useObjectiveBoard(commodoreId);
  const api = objectivesApi();
  useEffect(() => { if (api !== null) void loadBoard(api, commodoreId); }, [api, commodoreId]);
  const objective = board.loaded ? board.objectives.find((candidate) => candidate.id === objectiveId) ?? null : null;
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);
  const dueButton = useRef<HTMLButtonElement | null>(null);
  const readActivity = () => objectiveRecordSummaries().find((record) => record.id === objectiveId)?.activity ?? null;
  const activity = useSyncExternalStore(subscribeObjective, readActivity, readActivity);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 행 왼쪽에 선다 — 높이는 창 안에서 행 머리에 맞추고, 왼쪽 자리가 없으면 행 아래로 내린다.
  useLayoutEffect(() => {
    const place = () => {
      const node = ref.current;
      if (!node) return;
      const row = anchor.getBoundingClientRect();
      const height = Math.min(node.scrollHeight, window.innerHeight - EDGE * 2);
      const roomLeft = row.left - POPOVER_GAP - POPOVER_WIDTH >= EDGE;
      const left = roomLeft ? row.left - POPOVER_GAP - POPOVER_WIDTH : Math.max(EDGE, Math.min(row.left, window.innerWidth - POPOVER_WIDTH - EDGE));
      const top = roomLeft ? Math.max(EDGE, Math.min(row.top - 4, window.innerHeight - height - EDGE)) : Math.min(row.bottom + POPOVER_GAP, window.innerHeight - height - EDGE);
      setPosition({ left, top, width: POPOVER_WIDTH, maxHeight: window.innerHeight - EDGE * 2 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, objective]);

  // 자리가 잡혀 보이게 된 뒤 처음 한 번 팝업으로 초점을 옮긴다(숨은 동안에는 초점을 받지 못한다) — 화면 읽기가 제목부터 읽는다.
  const focused = useRef(false);
  useEffect(() => {
    if (position === null || focused.current) return;
    focused.current = true;
    ref.current?.focus({ preventScroll: true });
  }, [position]);
  const now = useNow();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 날짜 선택기가 떠 있으면 그 Esc는 선택기의 것이다 — 선택기가 먼저 닫힌다.
      if (event.key !== "Escape" || document.querySelector(".objectives-cal")) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current(true);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".commander-objective-popover, .objectives-cal, .objectives-result-window") || anchor.contains(target)) return;
      onCloseRef.current(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onPointer, true); };
  }, [anchor]);

  if (!objective) return null;
  const done = objective.missions.filter((mission) => mission.done).length;
  const total = objective.missions.length;
  const met = objective.criteria.filter((criterion) => criterion.met !== undefined).length;
  // 기한은 머리 「기한」 단추와 같은 기준으로 잠긴다 — 지휘관이 일하는 동안·끝난 목표는 바꾸지 않는다(서버도 같은 기준).
  const dueEditable = !objective.done && activity !== "running" && activity !== "background";
  const overdue = !!objective.dueDate && objective.dueDate < todayIso() && !objective.done;
  const decision = !objective.done && objective.decisionRequest !== null;
  const review = !objective.done && objective.awaitingReview;
  const recent = [...objective.results].sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT_RESULTS);
  const patchDue = (dueDate: string | null) => {
    if (api) void post(api, "/objective/patch", { objectiveId: objective.id, patch: { dueDate }, language }).catch(() => undefined);
  };
  const missionOf = (result: ObjectiveResult) => {
    const index = result.sourceMissionId ? objective.missions.findIndex((mission) => mission.id === result.sourceMissionId) : -1;
    return index >= 0 ? index + 1 : null;
  };
  const titleId = `commander-objective-popover-${objective.id}`;

  return createPortal(
    <div ref={ref} className="commander-objective-popover" role="dialog" aria-labelledby={titleId} tabIndex={-1} style={position ?? { visibility: "hidden", left: 0, top: 0, width: POPOVER_WIDTH }}
      onBlur={(event) => {
        // Tab으로 팝업을 벗어나면 닫는다 — 팝업은 문서 끝에 붙어 있어 그 뒤로는 갈 자리가 없다. 선택기·결과물 창으로 옮기는 초점은 안이다.
        const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
        if (!next || next.closest(".commander-objective-popover, .objectives-cal, .objectives-result-window")) return;
        onClose(false);
      }}>
      <div className="commander-objective-popover-head">
        <span className="commander-objective-popover-avatar" aria-hidden="true">{avatar}</span>
        <span className="commander-objective-popover-heading">
          <b id={titleId}>{objective.title}</b>
          {activityAt !== null ? <small>{t("objectives.popover.active", { ago: relative(activityAt, now, language) })}</small> : null}
        </span>
      </div>

      <section className="commander-objective-popover-sec" aria-label={t("objectives.popover.now")}>
        <h4>{t("objectives.popover.now")}</h4>
        <p className="commander-objective-popover-now">{statusLine}{toolLabel ? <small>{toolLabel}</small> : null}</p>
      </section>

      {decision || review ? (
        <section className="commander-objective-popover-sec" aria-label={t("objectives.popover.turn")}>
          <h4>{t("objectives.popover.turn")}</h4>
          <div className="commander-objective-popover-turn">
            <span>{decision ? t("objectives.popover.decision", { n: objective.decisionRequest!.questions.length }) : t("objectives.popover.review")}</span>
            <button type="button" onClick={() => { onClose(false); if (decision || !onReview) onOpenConversation(); else onReview(); }}>{t(decision ? "objectives.popover.answer" : "objectives.popover.reviewAction")}</button>
          </div>
        </section>
      ) : null}

      <section className="commander-objective-popover-sec" aria-label={t("objectives.popover.progress")}>
        <h4>{t("objectives.popover.progress")}</h4>
        <div className="commander-objective-popover-bars">
          <span>{t("objectives.missions.title")}</span><Meter done={done} total={total} /><span>{done}/{total}</span>
          <span>{t("objectives.criteria.title")}</span><Meter done={met} total={objective.criteria.length} /><span>{met}/{objective.criteria.length}</span>
        </div>
      </section>

      <section className="commander-objective-popover-sec" aria-label={t("objectives.criteria.title")}>
        <h4>{t("objectives.criteria.title")}</h4>
        {objective.criteria.length ? (
          <ul className="commander-objective-popover-criteria">
            {objective.criteria.map((criterion) => <li key={criterion.id} className={criterion.met !== undefined ? "is-met" : ""}><i aria-hidden="true">{criterion.met !== undefined ? "✓" : "○"}</i><span>{criterion.text}</span><span className="commander-objective-popover-sr">{criterion.met !== undefined ? t("objectives.popover.met") : t("objectives.popover.unmet")}</span></li>)}
          </ul>
        ) : <p className="commander-objective-popover-empty">{t("objectives.popover.noCriteria")}</p>}
      </section>

      <section className="commander-objective-popover-sec" aria-label={t("objectives.schedule.due")}>
        <h4>{t("objectives.schedule.due")}</h4>
        <button ref={dueButton} type="button" className={`commander-objective-popover-due${overdue ? " is-overdue" : ""}`} disabled={!dueEditable} aria-haspopup="dialog" aria-expanded={dateAnchor !== null}
          aria-label={objective.dueDate ? t("objectives.tabs.dueTip", { date: dueLabel(objective.dueDate, language) }) : t("objectives.schedule.setDue")}
          onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setDateAnchor((value) => (value ? null : rect)); }}>
          <CalGlyph /><span>{objective.dueDate ? dueLabel(objective.dueDate, language) : t("objectives.popover.noDue")}</span>{dueEditable ? <span className="commander-objective-popover-due-edit" aria-hidden="true">{t("objectives.popover.change")}</span> : null}
        </button>
        {dateAnchor ? <DatePicker anchor={dateAnchor} trigger={dueButton} value={objective.dueDate} language={language} t={t} onPick={patchDue} onClose={() => { setDateAnchor(null); dueButton.current?.focus(); }} /> : null}
      </section>

      <section className="commander-objective-popover-sec" aria-label={t("objectives.popover.recent")}>
        <h4>{t("objectives.popover.recent")}</h4>
        {recent.length ? recent.map((result) => {
          const n = missionOf(result);
          return (
            <button key={result.id} type="button" className="commander-objective-popover-result" onClick={(event) => openResultWindow(objective.id, result.id, event.currentTarget)}>
              <ResultGlyph result={result} />
              <span className="commander-objective-popover-result-name">{resultName(result, t)}</span>
              {n !== null ? <span className="commander-objective-popover-result-mission">{t("objectives.popover.mission", { n })}</span> : null}
            </button>
          );
        }) : <p className="commander-objective-popover-empty">{t("objectives.popover.noResults")}</p>}
      </section>

      <section className="commander-objective-popover-sec" aria-label={t("objectives.commander.title")}>
        <h4>{t("objectives.commander.title")}</h4>
        <div className="commander-objective-popover-commander">
          <LaunchControl t={t} model={objective.commander.routing ? undefined : objective.commander.model} effort={objective.commander.routing ? undefined : objective.commander.effort} locked onChange={() => undefined} />
          <span>{t("objectives.popover.members", { n: objective.members.length })}</span>
        </div>
      </section>

      <div className="commander-objective-popover-actions">
        <button type="button" className="is-primary" onClick={() => { onClose(false); onOpenConversation(); }}>{t("objectives.popover.openChat")}</button>
      </div>
    </div>,
    document.body,
  );
}

function Meter({ done, total }: { readonly done: number; readonly total: number }) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  return <span className={`commander-objective-popover-meter${total > 0 && done >= total ? " is-complete" : ""}`} aria-hidden="true"><span style={{ width: `${ratio * 100}%` }} /></span>;
}

function resultName(result: ObjectiveResult, t: ReturnType<typeof getT>): string {
  if (result.kind === "pr") return result.label ?? result.observation.title ?? `#${result.number} ${result.owner}/${result.repo}`;
  if (result.kind === "artifact") return result.label ?? t("objectives.results.artifact.untitled");
  return result.label ?? result.name;
}

/** 결과물 종류 글리프 — 라이브러리의 행과 같은 모양(PR·아티팩트·이미지·문서). */
function ResultGlyph({ result }: { readonly result: ObjectiveResult }) {
  const common = { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (result.kind === "pr") return <svg {...common}><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8M11.5 10.9V7a2.5 2.5 0 0 0-2.5-2.5H7" /></svg>;
  if (result.kind === "artifact") return <svg {...common}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6h12M6 8.5l-1.5 1.5L6 11.5M10 8.5l1.5 1.5-1.5 1.5" /></svg>;
  if (result.mediaType !== "text/plain") return <svg {...common}><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path d="m2.5 12 4-3.5 3 2.5 2-1.5 2 2" /></svg>;
  return <svg {...common}><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" /><path d="M9.5 2v3.5H13M5.8 8.5h4.4M5.8 11h3" /></svg>;
}
