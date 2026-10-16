import { useMemo, useState } from "react";
import type { HostSurfaceContext, HostSurfaceDescriptor } from "@fleet-console/sdk/host-context";
import type { ConversationParticipant, ConversationSpeaker } from "@fleet-console/sdk/conversation";
import { HostMessageComposer } from "@fleet-console/sdk/composer";
import { Select } from "@fleet-console/sdk/react/browser";
import { commodoreConversationEntries } from "./commodore-chat.js";
import { useHostObjectiveState } from "./host-state.js";
import { BriefSection, MissionRecords } from "./objectives-panel.js";
import { ObjectiveResults } from "./results.js";
import { DecisionList } from "./decisions.js";
import { openFollowups } from "./followups.js";
import { FollowupCandidateList } from "./followups-view.js";
import { LinkText } from "./link-text.js";
import { getT } from "./i18n/index.js";
import "./objectives.css";
import "./host-surfaces.css";

function HostCommodore({ context }: { readonly context: HostSurfaceContext }) {
  const { model, snapshot } = useHostObjectiveState(context);
  const t = getT(context.language);
  const theaterId = context.selection.theaterId ?? "";
  const { commodore } = snapshot;
  const entries = useMemo(() => commodoreConversationEntries(t, theaterId, commodore.entries, commodore.live, snapshot.objectives, commodore.view?.state.asks), [t, theaterId, commodore, snapshot.objectives]);
  const speaker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name: t("objectives.commodore.name") }), [t]);
  const running = commodore.view?.run.phase === "turn";
  const participants = useMemo<readonly ConversationParticipant[]>(() => [{ speaker, activity: running ? "running" : "idle" }], [speaker, running]);
  const [older, setOlder] = useState(false);
  const Conversation = context.chat.Conversation;
  const canMessage = context.canWrite() && commodore.view?.active === true;
  const messageContext = useMemo(() => ({ ...context, canWrite: () => context.canWrite() && model.getSnapshot().commodore.view?.active === true }), [context, model]);
  return <div className="objectives-commodore-conversation" data-host-key={context.selection.hostKey}>
    {snapshot.error ? <p className="objectives-commodore-failure" role="alert">{snapshot.error}</p> : null}
    <Conversation entries={entries} participants={participants} working={running ? [speaker] : []} language={context.language}
      theaterId={theaterId} loading={!commodore.transcriptLoaded} empty={t("objectives.commodore.log.empty")}
      older={commodore.hasMore ? { label: t("objectives.commodore.log.older"), loading: older, load: () => { setOlder(true); void model.older().catch(() => undefined).finally(() => { if (!model.signal.aborted) setOlder(false); }); } } : null}
      composer={<HostMessageComposer context={messageContext} send={model.message} label={t("objectives.commodore.composer.aria")} placeholder={t("objectives.commodore.composer.placeholder")} sendLabel={t("objectives.commodore.composer.send")}
        readOnlyLabel={canMessage ? "" : context.canWrite() ? t("objectives.commodore.composer.idle") : t("objectives.commodore.conversation.readOnly")} uploadUnsupported={t("objectives.host.uploadUnsupported")} />} />
  </div>;
}

/** 기존 상세의 브리핑·기록·결정·증거 renderer만 조립한다. 관리 동작을 local singleton에 연결하지 않는다. */
function HostObjectives({ context }: { readonly context: HostSurfaceContext }) {
  const { snapshot } = useHostObjectiveState(context);
  const t = getT(context.language);
  const key = `objective:${context.selection.theaterId}`;
  const [picked, setPicked] = useState<string | null>(() => context.state.read(key, context.selection.operationId));
  const [tab, setTab] = useState<"goal" | "crew" | "results">("goal");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openFollowup, setOpenFollowup] = useState<{ objectiveId: string; candidateId: string | null } | null>(null);
  const current = snapshot.objectives.find((objective) => objective.id === picked) ?? snapshot.objectives.find((objective) => objective.id === context.selection.operationId) ?? snapshot.objectives[0];
  const resource = useMemo(() => ({ url: context.transport.resourceUrl, read: context.readResource }), [context]);
  if (snapshot.loading) return <p role="status">{t("objectives.results.loading")}</p>;
  if (snapshot.error) return <p role="alert">{snapshot.error}</p>;
  if (!current) return <p>{t("objectives.switch.empty")}</p>;
  const collectedFollowups = current.done ? [] : openFollowups(current);
  return <section className="objectives-host-panel" data-host-key={context.selection.hostKey} data-objective-id={current.id}>
    <Select label={t("objectives.panel.title")} value={current.id} options={snapshot.objectives.map((objective) => ({ value: objective.id, label: objective.title }))}
      onChange={(value) => { context.state.write(key, value); setPicked(value); }} />
    <p className="objectives-host-note">{context.hostLabel} · {current.title}</p>
    <div className="objectives-host-tabs" role="tablist" aria-label={t("objectives.tabs.aria")}>
      {(["goal", "crew", "results"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{t(`objectives.tabs.${value}`)}</button>)}
    </div>
    {tab === "goal" ? <>
      <BriefSection objective={current} t={t} language={context.language} touchable={false} call={async () => null} origin={null} resourceUrl={context.transport.resourceUrl} />
      <section className="objectives-group"><h3>{t("objectives.criteria.title")}</h3>
        {current.criteria.map((criterion, index) => <div className="objectives-criterion" key={criterion.id}><span className="objectives-criterion-number">{index + 1}</span><span className="objectives-criterion-body"><LinkText text={criterion.text} /></span><span title={criterion.met}>{criterion.met ? "✓" : "—"}</span></div>)}
      </section>
      {current.decisionRequest ? <section className="objectives-group">{current.decisionRequest.questions.map((question) => <div key={question.id}><h3>{question.header}</h3><p><LinkText text={question.text} /></p>{question.options.map((option, index) => <p key={index}>{typeof option === "string" ? option : option.label}</p>)}</div>)}</section> : null}
      <DecisionList objective={current} t={t} language={context.language} flash={null} memberMark={() => null} />
    </> : tab === "crew" ? <>
      <section className="objectives-group"><h3>{t("objectives.members.title")}</h3>{current.members.map((member) => <div className="objectives-member" key={member.id}><strong>{member.role}</strong><span>{member.brief}</span></div>)}</section>
      {current.missions.map((mission, index) => <section className="objectives-group" key={mission.id}>
        <h3>{index + 1}. {mission.text}</h3><p>{mission.done ? "✓" : "—"} · {current.members.find((member) => member.id === mission.member)?.role ?? "—"}</p>
        <MissionRecords id={`host-records-${mission.id}`} records={mission.records} seenAtOpen={new Set(mission.records.map((record) => record.id))} open t={t} language={context.language} />
      </section>)}
    </> : <>
      <ObjectiveResults objective={current} t={t} language={context.language} resource={resource} highlightMission={null} groupOpen={(group) => !collapsed.has(group)} onToggleGroup={(group) => setCollapsed((previous) => { const next = new Set(previous); if (next.has(group)) next.delete(group); else next.add(group); return next; })} />
      {collectedFollowups.length ? <section className="objectives-group">
        <h3>{t("objectives.followup.results")}</h3>
        <p className="objectives-followup-caption">{t("objectives.followup.collected", { n: collectedFollowups.length })}</p>
        <FollowupCandidateList candidates={collectedFollowups} selectable={false} selection={new Set<string>()} t={t}
          idPrefix={`host-followups-${current.id}`} openId={openFollowup?.objectiveId === current.id ? openFollowup.candidateId : null}
          onOpenChange={(candidateId) => setOpenFollowup({ objectiveId: current.id, candidateId })} onToggleCheck={() => undefined} />
      </section> : null}
    </>}
    <p className="objectives-host-note">{t("objectives.host.managementReadOnly")}</p>
  </section>;
}

export const objectiveHostSurfaces: readonly HostSurfaceDescriptor[] = [
  { id: "commodore", slot: "conversation", role: "commodore", render: (context) => <HostCommodore context={context} /> },
  { id: "objectives", slot: "objectives", render: (context) => <HostObjectives context={context} /> },
];
