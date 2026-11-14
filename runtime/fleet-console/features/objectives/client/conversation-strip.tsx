import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import type { MissionRevealPort } from "../../execution/client/agent/chat/group/mission-reveal-context.js";
import type { ConversationPillTakeover } from "../../workspace/shared/conversation-pill.js";
import type { Objective } from "../shared/types.js";
import { getT } from "./i18n/index.js";
import { findAnyObjective, hasDecisionRequest, loadObjective, subscribeObjectiveOrFinished, useObjectiveSummaries } from "./objectives-state.js";
import { openObjectivePopup, CommanderMark, shownActivity } from "./objectives-panel.js";
import { openResultWindow } from "./result-window.js";
import { CrewMissionsArea, crewMissionsCount } from "./rail/crew-missions-area.js";
import { GoalArea, goalAreaCount } from "./rail/goal-area.js";
import { ResultsArea, resultsCount } from "./rail/results-area.js";
import "./rail/objective-rail.css";
import "./conversation-strip.css";

const AREAS = ["goal", "crew", "results"] as const;
type Area = typeof AREAS[number];
export interface MissionRevealRequest { readonly missionId: string; readonly revision: number }

export function useObjectiveMissionReveal(objectiveId: string, bodyId: string, language: "en" | "ko") {
  const [request, setRequested] = useState<(MissionRevealRequest & { readonly objectiveId: string; readonly bodyId: string }) | null>(null);
  const requested = request?.objectiveId === objectiveId && request.bodyId === bodyId ? request : null;
  const reveal = useCallback((missionId: string) => setRequested((current) => ({ objectiveId, bodyId, missionId, revision: (current?.revision ?? 0) + 1 })), [objectiveId, bodyId]);
  const port = useMemo<MissionRevealPort>(() => ({ objectiveId, reveal, label: getT(language)("objectives.rail.strip.openMission") }), [objectiveId, reveal, language]);
  return { requested, port };
}

export function ObjectiveConversationStrip({ objectiveId, memberId, language, title, takeover, controls, requested }: {
  readonly objectiveId: string;
  readonly memberId: string | null;
  readonly language: "en" | "ko";
  readonly title: string;
  readonly takeover: ConversationPillTakeover | null;
  readonly controls?: ReactNode;
  readonly requested: MissionRevealRequest | null;
}) {
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, () => findAnyObjective(objectiveId), () => null);
  useEffect(() => {
    if (objective === null) void loadObjective(objectiveId).catch(() => undefined);
  }, [objectiveId, objective]);
  if (!objective) return <div className="objectives-conversation-strip objectives-conversation-strip-loading" role="status">{title} · {getT(language)("objectives.rail.area.loading")}</div>;
  return <LoadedStrip key={`${objectiveId}:${memberId ?? ""}`} objective={objective} memberId={memberId} language={language} takeover={takeover} controls={controls} requested={requested} />;
}

function LoadedStrip({ objective, memberId, language, takeover, controls, requested }: {
  readonly objective: Objective;
  readonly memberId: string | null;
  readonly language: "en" | "ko";
  readonly takeover: ConversationPillTakeover | null;
  readonly controls?: ReactNode;
  readonly requested: MissionRevealRequest | null;
}) {
  const t = getT(language);
  const id = useId();
  const summaries = useObjectiveSummaries();
  const objectiveRecordState = (objectiveId: string) => shownActivity(summaries.find((record) => record.id === objectiveId)?.activity ?? "closed");
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<Area, HTMLButtonElement>>>({});
  const tabs = useRef<Partial<Record<Area, HTMLButtonElement>>>({});
  const opener = useRef<Area>("goal");
  const [area, setArea] = useState<Area | null>(null);
  const [lastArea, setLastArea] = useState<Area>("goal");
  const [missionRequest, setMissionRequest] = useState<MissionRevealRequest | null>(null);
  const handledRequest = useRef<MissionRevealRequest | null>(null);
  const member = objective.members.find((candidate) => candidate.id === memberId);
  const missions = memberId ? objective.missions.filter((mission) => mission.member === memberId) : objective.missions;
  const done = missions.filter((mission) => mission.done).length;
  const progress = t("objectives.rail.goal.progress", { done, total: missions.length });
  const counts = { goal: `${t("objectives.rail.goal.criteria")} ${goalAreaCount(objective, language) || "0/0"}`, crew: memberId ? progress : crewMissionsCount(objective, language), results: String(resultsCount(objective)) };
  const close = useCallback(() => {
    setArea(null);
    triggers.current[opener.current]?.focus({ preventScroll: true });
  }, []);
  const select = (next: Area, fromStrip = false) => {
    if (fromStrip) opener.current = next;
    setArea(fromStrip && area === next ? null : next);
    setLastArea(next);
    if (fromStrip && area === next) triggers.current[next]?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!requested || handledRequest.current === requested || !objective.missions.some((mission) => mission.id === requested.missionId)) return;
    handledRequest.current = requested;
    opener.current = "crew";
    setArea("crew");
    setLastArea("crew");
    setMissionRequest(requested);
  }, [requested, objective.missions]);
  useEffect(() => {
    if (!area) return;
    const pointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("click", pointer);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("click", pointer); document.removeEventListener("keydown", key, true); };
  }, [area, close]);
  useEffect(() => {
    if (takeover) setArea(null);
  }, [takeover?.key]);
  const keyTabs = (event: KeyboardEvent<HTMLButtonElement>, current: Area, panel: boolean) => {
    let next: Area | undefined;
    const index = AREAS.indexOf(current);
    if (event.key === "ArrowRight") next = AREAS[(index + 1) % AREAS.length];
    if (event.key === "ArrowLeft") next = AREAS[(index + AREAS.length - 1) % AREAS.length];
    if (event.key === "Home") next = AREAS[0];
    if (event.key === "End") next = AREAS[AREAS.length - 1];
    if (!next) return;
    event.preventDefault();
    setLastArea(next);
    // 띠에서 방향키로 옮긴 칸이 닫을 때 포커스가 돌아갈 자리다.
    if (!panel) opener.current = next;
    if (panel || area !== null) setArea(next);
    (panel ? tabs : triggers).current[next]?.focus();
  };
  const label = (key: Area) => t(`objectives.rail.area.${key}`);
  return <div className="objectives-conversation-strip" ref={root}>
    <div className="objectives-conversation-strip-summary" role={takeover ? "group" : "tablist"} aria-label={takeover?.label ?? t("objectives.rail.strip.status")} id={takeover?.id} onKeyDown={takeover?.onKeyDown}>
      {AREAS.map((key) => <button key={key} type="button" ref={(element) => { if (element) triggers.current[key] = element; }}
        className={`objectives-conversation-strip-segment is-${key}`} hidden={!!takeover && key !== "goal"}
        role={takeover ? undefined : "tab"} id={`${id}-trigger-${key}`} aria-controls={area ? `${id}-panel-${key}` : undefined} inert={(!!takeover && key === "goal" && !takeover.onOwnerPress) || undefined}
        aria-selected={takeover ? undefined : (area ?? lastArea) === key} aria-expanded={area === key} tabIndex={takeover || (area ?? lastArea) === key ? 0 : -1}
        aria-label={key === "goal" && takeover ? takeover.ownerLabel : undefined}
        onClick={() => { if (key === "goal" && takeover) takeover.onOwnerPress?.(); else select(key, true); }}
        onKeyDown={takeover ? undefined : (event) => keyTabs(event, key, false)}>
        {key === "goal" ? <CommanderMark objective={objective} objectiveRecordState={objectiveRecordState} size={20} /> : null}
        <span className="objectives-conversation-strip-title">{key === "goal" ? <>{objective.title}{member ? ` › ${member.role}` : ""}</> : label(key)}</span>
        {!takeover ? <span className="objectives-conversation-strip-count">{counts[key]}</span> : null}
        {key === "goal" && hasDecisionRequest(objective) ? <span className="objectives-conversation-strip-decision" role="img" aria-label={t("objectives.rail.goal.decision")} title={t("objectives.rail.goal.decision")} /> : null}
        {key === "crew" ? <span className="objectives-conversation-strip-progress" role="progressbar" aria-label={progress} aria-valuemin={0} aria-valuemax={Math.max(1, missions.length)} aria-valuenow={done}><i style={{ width: `${missions.length ? done / missions.length * 100 : 0}%` }} /></span> : null}
      </button>)}
      {takeover ? <span className="objectives-conversation-strip-peer" key={takeover.key}>{takeover.content}</span> : controls ? <span className="objectives-conversation-strip-controls">{controls}</span> : null}
    </div>
    {area ? <section className="objectives-conversation-strip-panel" aria-label={label(area)}>
      <div className="objectives-conversation-strip-head">
        <div className="objectives-conversation-strip-tabs" role="tablist" aria-label={t("objectives.rail.strip.status")}>
          {AREAS.map((key) => <button type="button" key={key} role="tab" id={`${id}-tab-${key}`} aria-controls={`${id}-panel-${key}`} aria-selected={area === key} tabIndex={area === key ? 0 : -1}
            ref={(element) => { if (element) tabs.current[key] = element; }} onClick={() => select(key)} onKeyDown={(event) => keyTabs(event, key, true)}>{label(key)}</button>)}
        </div>
        <span className="objectives-conversation-strip-panel-count">{counts[area]}</span>
        <button type="button" className="objectives-conversation-strip-more" onClick={(event) => {
          const returnFocus = triggers.current[area] ?? event.currentTarget;
          setArea(null);
          if (area === "results") openResultWindow(objective.id, "", returnFocus);
          else openObjectivePopup(objective.id, area, undefined, returnFocus);
        }}>{t(`objectives.rail.area.${area === "goal" ? "expand" : area === "crew" ? "graph" : "viewer"}`)}</button>
        <button type="button" aria-label={t("objectives.detail.close")} onClick={close}>×</button>
      </div>
      {AREAS.map((key) => <div key={key} className="objectives-conversation-strip-body" role="tabpanel" id={`${id}-panel-${key}`} aria-labelledby={`${id}-tab-${key}`} hidden={area !== key} tabIndex={0}>
        {key === "goal" ? <GoalArea objective={objective} language={language} /> : key === "crew" ? <CrewMissionsArea objective={objective} language={language} memberId={memberId} reveal={missionRequest} /> : <ResultsArea objective={objective} language={language} />}
      </div>)}
    </section> : null}
  </div>;
}
