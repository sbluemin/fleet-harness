import { useCallback, useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { missionReady, missionTitle, unseenRecords, type Objective, type ObjectiveMember, type ObjectiveMission } from "../../shared/types.js";
import { getT } from "../i18n/index.js";
import { launchedWords, memberLaunched, memberStatus, useLaunchRows } from "../launch-control.js";
import { graphMissionStates, type MissionState } from "../graph.js";
import { useOpenMissionRecords } from "../mission-record-open.js";
import { objectivesApi, post, useObjectiveSummaries } from "../objectives-state.js";
import { CommanderMark, MemberMark, MissionRecords, quietMissionLabel, shownActivity } from "../objectives-panel.js";
import "./crew-results.css";

/** 임무 상태 → 공용 태그 클래스. */
const missionTagClass = (state: MissionState): string =>
  state === "done" ? "is-ok" : state === "running" || state === "ready" ? "is-run" : "is-wait";

export function crewMissionsCount(objective: Objective, language: "en" | "ko"): string {
  const done = objective.missions.filter((mission) => mission.done).length;
  return getT(language)("objectives.rail.crew.count", {
    members: objective.members.length + 1,
    done,
    total: objective.missions.length,
  });
}

function CrewMemberRow({ objective, member, count, t, objectiveRecordState, labels, launchWords: rows }: {
  readonly objective: Objective;
  readonly member: ObjectiveMember;
  readonly count: number;
  readonly t: ReturnType<typeof getT>;
  readonly objectiveRecordState: (objectiveId: string) => string;
  readonly labels: { readonly auto: string; readonly fallback: string };
  readonly launchWords: ReturnType<typeof useLaunchRows>;
}) {
  const state = member.sessionName !== null ? objectiveRecordState(member.id) : "closed";
  const launched = memberLaunched(member, objectiveRecordState);
  const { text: status, failed } = memberStatus(member, state, objective, t);
  const picked = member.launch && member.launch.mode === "model" ? member.launch : null;
  const modelLine = launched || picked
    ? launchedWords(rows, launched ? member.model : picked?.model, launched ? member.effort : picked?.effort, labels).title
    : t("objectives.members.assigned");
  return (
    <li className="objective-rail-row objective-rail-crew-member">
      <span className="objective-rail-crew-mark"><MemberMark objective={objective} member={member} objectiveRecordState={objectiveRecordState} still size={20} /></span>
      <span className="objective-rail-crew-main">
        <span className="objective-rail-crew-name">{member.role}</span>
        <small>{modelLine} · {t("objectives.members.missions", { count })}</small>
      </span>
      {state !== "closed" && status !== "" ? (
        <span className={`objective-rail-tag${failed ? " is-bad" : state === "running" ? " is-run" : state === "awaiting" ? " is-wait" : ""}`}>{status}</span>
      ) : null}
    </li>
  );
}

function MissionRow({ objective, mission, index, t, language, states, objectiveRecordState, open, seenAtOpen, onToggle, focused }: {
  readonly focused: boolean;
  readonly objective: Objective;
  readonly mission: ObjectiveMission;
  readonly index: number;
  readonly t: ReturnType<typeof getT>;
  readonly language: "en" | "ko";
  readonly states: ReadonlyMap<string, MissionState>;
  readonly objectiveRecordState: (objectiveId: string) => string;
  readonly open: boolean;
  readonly seenAtOpen: ReadonlySet<string>;
  readonly onToggle: () => void;
}) {
  const state = states.get(mission.id) ?? "ready";
  const owner = mission.member ? objective.members.find((member) => member.id === mission.member) : null;
  const ownerName = owner?.role ?? t("objectives.commander.title");
  const ready = missionReady(objective.missions, mission);
  const quiet = quietMissionLabel(objective, mission, ready, Date.now(), language);
  const prereqs = mission.prerequisites
    .map((id) => objective.missions.findIndex((candidate) => candidate.id === id) + 1)
    .filter((n) => n > 0);
  const unseen = unseenRecords(mission);
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); }
  };
  return (
    <li className="objective-rail-row objective-rail-crew-mission" data-mission-id={mission.id} data-member-focus={focused || undefined}>
      <div
        className="objective-rail-crew-mission-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={onKey}
      >
        <span className={`objective-rail-crew-num is-${state}`} aria-hidden="true">{mission.done ? "✓" : index + 1}</span>
        <span className="objective-rail-crew-main">
          <span className="objective-rail-crew-name">{missionTitle(mission)}{unseen > 0 ? <i className="objective-rail-crew-unseen" title={t("objectives.tabs.unseenDot")} /> : null}</span>
          <small>{ownerName}{prereqs.length > 0 ? ` · ${t("objectives.missions.prerequisites", { missions: prereqs.join("·") })}` : ""}{quiet ? ` · ${quiet}` : ""}</small>
        </span>
        <span className={`objective-rail-tag ${missionTagClass(state)}`}>{t(`objectives.graph.state.${state}`)}</span>
      </div>
      {open ? (
        mission.records.length > 0 ? (
          <MissionRecords
            id={`rail-records-${mission.id}`}
            records={mission.records}
            seenAtOpen={seenAtOpen}
            open
            t={t}
            language={language}
          />
        ) : (
          <span className="objective-rail-crew-rec">{t("objectives.rail.crew.noRecords")}</span>
        )
      ) : null}
    </li>
  );
}

/** 가운데 영역 본문 — 구성원(지휘관 포함) → 임무 순. 머리·스크롤은 골격이 감싼다. */
export function CrewMissionsArea({ objective, language, memberId = null, reveal = null }: {
  objective: Objective;
  language: "en" | "ko";
  memberId?: string | null;
  reveal?: { readonly missionId: string; readonly revision: number } | null;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const handledReveal = useRef<typeof reveal>(null);
  const t = getT(language);
  const rows = useLaunchRows();
  const summaries = useObjectiveSummaries();
  const api = objectivesApi();
  const markSeen = useCallback((path: string, body: Record<string, unknown>) => {
    if (api === null) return Promise.resolve(null);
    return post(api, path, { ...body, language }).catch(() => null);
  }, [api, language]);
  const { openRecords, toggleRecords, openMissionRecords } = useOpenMissionRecords(objective, markSeen);
  useEffect(() => {
    if (!reveal || handledReveal.current === reveal) return;
    const mission = objective.missions.find((candidate) => candidate.id === reveal.missionId);
    if (!mission) return;
    handledReveal.current = reveal;
    openMissionRecords(mission);
  }, [reveal, objective.missions, openMissionRecords]);
  const revealedOpen = reveal !== null && reveal.missionId in openRecords;
  useEffect(() => {
    if (!reveal || !revealedOpen) return;
    const row = [...root.current?.querySelectorAll<HTMLElement>("[data-mission-id]") ?? []].find((element) => element.dataset.missionId === reveal.missionId);
    row?.scrollIntoView({ block: "nearest" });
    row?.querySelector<HTMLElement>("[role=button]")?.focus({ preventScroll: true });
  }, [reveal, revealedOpen]);
  const orderedMissions = objective.missions.map((mission, index) => ({ mission, index }));
  if (memberId) orderedMissions.sort((a, b) => Number(b.mission.member === memberId) - Number(a.mission.member === memberId));
  const recordOf = (id: string) => summaries.find((candidate) => candidate.id === id) ?? null;
  const objectiveRecordState = (id: string): string => shownActivity(recordOf(id)?.activity ?? "closed");
  const objectiveRecordOwnState = (id: string): string => {
    const record = recordOf(id);
    return shownActivity(record?.ownActivity ?? record?.activity ?? "closed");
  };
  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  const states = graphMissionStates(objective, objectiveRecordOwnState);

  const commanderState = objectiveRecordOwnState(objective.id);
  const commanderModel = objective.commander.model
    ? launchedWords(rows, objective.commander.model, objective.commander.effort, labels).title
    : t("objectives.members.assigned");
  const commanderMissions = objective.missions.filter((mission) => mission.member === null).length;
  const commanderFailed = objective.commander.outcome === "failed" && commanderState !== "running" && commanderState !== "awaiting";
  const commanderStatus = commanderState === "running" ? t("objectives.members.working")
    : commanderState === "awaiting" ? t("objectives.awaiting.word")
    : commanderState === "ended" ? t("objectives.members.dormant")
    : commanderState === "archived" ? t("objectives.members.archived")
    : t("objectives.members.idle");

  return (
    <div ref={root}>
      <div className="objective-rail-section">
        <div className="objective-rail-section-head">{t("objectives.members.title")} <em>{objective.members.length + 1}</em></div>
        <ul className="objective-rail-list">
          <li className="objective-rail-row objective-rail-crew-member">
            <span className="objective-rail-crew-mark"><CommanderMark objective={objective} objectiveRecordState={objectiveRecordState} size={20} /></span>
            <span className="objective-rail-crew-main">
              <span className="objective-rail-crew-name">{t("objectives.commander.title")}</span>
              <small>{commanderModel} · {t("objectives.members.missions", { count: commanderMissions })}</small>
            </span>
            {commanderState !== "closed" ? (
              <span className={`objective-rail-tag${commanderFailed ? " is-bad" : commanderState === "running" ? " is-run" : commanderState === "awaiting" ? " is-wait" : ""}`}>{commanderStatus}</span>
            ) : null}
          </li>
          {objective.members.map((member) => (
            <CrewMemberRow
              key={member.id}
              objective={objective}
              member={member}
              count={objective.missions.filter((mission) => mission.member === member.id).length}
              t={t}
              objectiveRecordState={objectiveRecordState}
              labels={labels}
              launchWords={rows}
            />
          ))}
        </ul>
      </div>
      {objective.missions.length > 0 ? (
        <div className="objective-rail-section">
          <div className="objective-rail-section-head">{t("objectives.missions.title")} <em>{objective.missions.filter((mission) => mission.done).length}/{objective.missions.length}</em></div>
          <ul className="objective-rail-list">
            {orderedMissions.map(({ mission, index }) => (
              <MissionRow
                focused={memberId !== null && mission.member === memberId}
                key={mission.id}
                objective={objective}
                mission={mission}
                index={index}
                t={t}
                language={language}
                states={states}
                objectiveRecordState={objectiveRecordState}
                open={mission.id in openRecords}
                seenAtOpen={openRecords[mission.id] ?? new Set()}
                onToggle={() => toggleRecords(mission)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
