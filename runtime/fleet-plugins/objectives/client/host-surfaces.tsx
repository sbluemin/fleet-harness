import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HostSurfaceContext, HostSurfaceDescriptor } from "@fleet-console/sdk/host-context";
import type { ConversationParticipant, ConversationSpeaker } from "@fleet-console/sdk/conversation";
import { CommodoreReferenceProvider, useCommodoreReferenceHost } from "./commodore-reference-input.js";
import { Select } from "@fleet-console/sdk/react/browser";
import { commodoreConversationEntries } from "./commodore-chat.js";
import { useHostObjectiveState } from "./host-state.js";
import { ObjectiveScheduleTools } from "./head-tabs.js";
import { ObjectiveDetail, ObjectiveDetailProvider, DETAIL_TABS, type ObjectiveDetailPorts, type DetailTab } from "./objectives-panel.js";
import { LaunchRosterProvider } from "./launch-control.js";
import { objectiveConversation } from "./conversation.js";
import { objectiveConversationActions } from "./conversation-actions.js";
import { getT } from "./i18n/index.js";
import "./objectives.css";
import "./host-surfaces.css";

function HostCommodore({ context }: { readonly context: HostSurfaceContext }) {
  const { model } = useHostObjectiveState(context);
  return <LaunchRosterProvider value={model.models}><CommodoreReferenceProvider value={model.references}><HostCommodoreBody context={context} /></CommodoreReferenceProvider></LaunchRosterProvider>;
}

function HostCommodoreBody({ context }: { readonly context: HostSurfaceContext }) {
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
  const [failure, setFailure] = useState<string | null>(null);
  const references = useCommodoreReferenceHost(t, theaterId);
  const { CommodoreComposer, CommodoreClearButton } = model.commodoreUi;
  const AskCards = model.AskCards;
  const fail = (cause: unknown) => { if (!model.signal.aborted) setFailure(cause instanceof Error ? cause.message : "objectives_unavailable"); };
  return <div className="objectives-commodore-conversation" data-host-key={context.selection.hostKey}>
    {snapshot.error || failure ? <p className="objectives-commodore-failure" role="alert">{failure ?? snapshot.error}</p> : null}
    {commodore.view?.run.phase === "error" || commodore.view?.run.phase === "retrying" ? <div className="objectives-commodore-retry"><span>{commodore.view.run.reason}</span><button type="button" disabled={!context.canWrite()} className="objectives-commodore-text-button" onClick={() => { void model.request("/commodore/retry", { theaterId }).catch(fail); }}>{t("objectives.commodore.drawer.retryNow")}</button></div> : null}
    <fieldset disabled={!context.canWrite()} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><AskCards theaterId={theaterId} t={t} onEnded={fail} /></fieldset>
    <Conversation references={references} openBoardAction={{ label: t("objectives.commodore.trail.open"), open: (entry) => { if (entry.objectiveId) model.references.openObjective(theaterId, entry.objectiveId); } }} entries={entries} participants={participants} working={running ? [speaker] : []} language={context.language}
      theaterId={theaterId} loading={!commodore.transcriptLoaded} empty={t("objectives.commodore.log.empty")}
      older={commodore.hasMore ? { label: t("objectives.commodore.log.older"), loading: older, load: () => { setOlder(true); void model.older().catch(() => undefined).finally(() => { if (!model.signal.aborted) setOlder(false); }); } } : null}
      composer={<footer className="objectives-commodore-foot"><fieldset disabled={!context.canWrite()} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <CommodoreComposer t={t} theaterId={theaterId} active={context.canWrite() && commodore.view?.active === true} context={commodore.view?.run.context} onFail={fail} onClear={() => setFailure(null)} />
        <CommodoreClearButton t={t} theaterId={theaterId} onFail={fail} onClear={() => setFailure(null)} />
      </fieldset>{!context.canWrite() ? <p>{t("objectives.commodore.conversation.readOnly")}</p> : null}</footer>} />
  </div>;
}

/** 목표의 보드 사실과 기존 액션만 실행 기능에 준다. 미시작 목표에는 세션/원장을 합성하지 않는다. */
function HostCommander({ context }: { readonly context: HostSurfaceContext }) {
  const { model, snapshot } = useHostObjectiveState(context);
  const operations = useSyncExternalStore(context.operations.subscribe, context.operations.getSnapshot, context.operations.getSnapshot);
  const t = getT(context.language);
  const objective = snapshot.objectives.find((entry) => entry.id === context.selection.operationId);
  const operation = operations.find((entry) => entry.id === context.selection.operationId);
  const stateOf = (id: string) => {
    const activity = operations.find((entry) => entry.id === id)?.activity;
    return activity === "background" ? "running" : activity ?? "closed";
  };
  const Conversation = context.OperationConversation;
  if (!objective) return snapshot.loading || !operation ? <p role={snapshot.error ? "alert" : "status"}>{snapshot.error ?? t(snapshot.loading ? "objectives.results.loading" : "objectives.switch.empty")}</p> : <Conversation context={context} title={operation.title} readOnlyLabel={t("objectives.commodore.conversation.readOnly")} />;
  const open = () => context.state.write("pickedObjective", objective.id);
  const actions = objectiveConversationActions(objective, { request: model.request, board: model.board.objectiveBoardActions });
  const conversation = objectiveConversation(objective, (index) => ["teal", "amber", "plum", "moss", "cerulean", "rose", "indigo", "crimson"][index % 8]!, open, undefined, actions, { state: stateOf, roster: model.models.read("launch") }, snapshot.commodore.view?.active === true, {
    returnPersonHold: async (objectiveId, target) => { await model.request("/person-hold/return", { objectiveId, target }); },
    revealCriteria: () => { open(); context.state.write("detailTab", "goal"); },
    followupPickable: model.board.followupPickable,
    setFollowupOpen: model.followups.setFollowupOpen,
  });
  return <LaunchRosterProvider value={model.models}>
    {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
    <Conversation context={context} title={objective.title} operationExists={!!operation} conversation={conversation} readOnlyLabel={t("objectives.commodore.conversation.readOnly")} />
  </LaunchRosterProvider>;
}

const EMPTY_COLLAPSED: Readonly<Record<string, boolean>> = Object.freeze({});

/** 로컬과 같은 상세·검증·편집 UI다. 전송·모델·자원·선택만 host 포트로 바꾼다. */
function HostObjectives({ context }: { readonly context: HostSurfaceContext }) {
  const { model, snapshot } = useHostObjectiveState(context);
  const t = getT(context.language);
  const operations = useSyncExternalStore(context.operations.subscribe, context.operations.getSnapshot, context.operations.getSnapshot);
  const picked = useSyncExternalStore(context.state.subscribe, () => context.state.read<string | null>("pickedObjective", context.selection.operationId));
  const tab = useSyncExternalStore(context.state.subscribe, () => context.state.read<DetailTab>("detailTab", "goal"));
  const collapsed = useSyncExternalStore(context.state.subscribe, () => context.state.read("detailCollapsed", EMPTY_COLLAPSED));
  const current = snapshot.objectives.find((objective) => objective.id === context.selection.operationId) ?? snapshot.objectives.find((objective) => objective.id === picked) ?? snapshot.objectives[0];
  const detailRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ports = useMemo<ObjectiveDetailPorts>(() => ({
    canWrite: context.canWrite,
    useLedgerOperation: () => null,
    canOpenLedger: () => false,
    toggleLedger: () => { throw new Error("ledger_unavailable"); },
    focusOperation: (id) => { void context.navigation.focusOperation(id).catch((cause: unknown) => { if (!model.signal.aborted) setError(cause instanceof Error ? cause.message : "host_selection_missing"); }); },
    resource: { url: context.transport.resourceUrl, read: context.readResource },
    upload: { request: context.transport.request, signal: model.signal, canWrite: context.canWrite },
  }), [context, model]);
  const call = async <R,>(path: string, body: Record<string, unknown>): Promise<R | null> => {
    try { const result = await model.request<R>(path, body); if (!model.signal.aborted) setError(null); return result; }
    catch (cause) { if (!model.signal.aborted) setError(cause instanceof Error ? cause.message : "objectives_unavailable"); return null; }
  };
  const operationState = (id: string): string => {
    const operation = operations.find((entry) => entry.id === id);
    return operation ? operation.activity === "background" ? "running" : operation.activity ?? "unknown" : "closed";
  };
  const toggle = (key: string) => context.state.write("detailCollapsed", { ...collapsed, [key]: !collapsed[key] });
  const open = (id: string) => {
    context.state.write("pickedObjective", id);
    void context.navigation.focusObjective(id).catch((cause: unknown) => { if (!model.signal.aborted) setError(cause instanceof Error ? cause.message : "host_selection_missing"); });
  };
  if (snapshot.loading) return <p role="status">{t("objectives.results.loading")}</p>;
  return <LaunchRosterProvider value={model.models}><ObjectiveDetailProvider value={ports}>
    <section className="objectives-host-panel" data-host-key={context.selection.hostKey} data-objective-id={current?.id}>
      {error || snapshot.error ? <p role="alert">{error ?? snapshot.error}</p> : null}
      <Select label={t("objectives.panel.title")} value={current?.id ?? ""} options={snapshot.objectives.map((objective) => ({ value: objective.id, label: objective.title }))} onChange={open} />
      {/* 고른 목록 값과 같은 제목을 다시 세우지 않는다 — 지금 보는 Operation 이 이 목표가 아닐 때만 그 목표로 가는 입구가 선다. */}
      <div className="objectives-pick-shortcuts objectives-host-shortcuts">
        {current && current.id !== context.selection.operationId ? <button type="button" onClick={() => open(current.id)}>{current.title}</button> : null}
        <button type="button" disabled={!context.canWrite()} onClick={context.navigation.openNewOperation}>{t("objectives.none.newOperation")}</button>
      </div>
      {current ? <>
        <ObjectiveScheduleTools objective={current} language={context.language} editable={context.canWrite() && !current.done && operationState(current.id) !== "running"}
          patch={(patch) => { void call("/objective/patch", { objectiveId: current.id, patch }); }} />
        <div className="objectives-host-tabs" role="tablist" aria-label={t("objectives.tabs.aria")}>
          {DETAIL_TABS.map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => context.state.write("detailTab", value)}>{t(`objectives.tabs.${value}`)}</button>)}
        </div>
      </> : null}
      {current ? <ObjectiveDetail key={current.id} objective={current} t={t} language={context.language} call={call} request={model.request}
        toast={() => undefined} modeLabel={(mode) => t(mode === "direct" ? "objectives.mode.direct" : mode === "coordinate" ? "objectives.mode.coordinate" : "objectives.mode.mixed")}
        stateLabel={(state) => t(state === "running" ? "objectives.state.running" : state === "awaiting" ? "objectives.state.awaiting" : state === "idle" ? "objectives.state.idle" : state === "ended" ? "objectives.state.ended" : state === "closed" ? "objectives.state.closed" : "objectives.state.unknown")}
        operationTitle={(id) => operations.find((entry) => entry.id === id)?.title ?? "—"} operationState={operationState} operationOwnState={operationState}
        busy={operationState(current.id) === "running"} tab={tab} onTab={(value) => context.state.write("detailTab", value)}
        sectionOpen={(key) => collapsed[key] === true} onToggleSection={toggle} groupOpen={(key) => collapsed[key] === true} onToggleGroup={toggle}
        onOpenGroup={(key) => context.state.write("detailCollapsed", { ...collapsed, [key]: true })} highlightMission={null} detailRef={detailRef}
        onToggleEdge={async (from, to, linked) => { await call("/edge/toggle", { objectiveId: current.id, from, to, linked }); }} onOpenObjective={open} />
        : <p>{t("objectives.switch.empty")}</p>}
    </section>
  </ObjectiveDetailProvider></LaunchRosterProvider>;
}

function HostCommodoreRail({ context }: { readonly context: HostSurfaceContext }) {
  const { model, snapshot } = useHostObjectiveState(context);
  const t = getT(context.language);
  const [tab, setTab] = useState("goals");
  const [error, setError] = useState<string | null>(null);
  const { CommodoreDirective, CommodoreIntel, CommodoreSettings } = model.commodoreUi;
  const view = snapshot.commodore.view;
  const theaterId = context.selection.theaterId ?? "";
  const fail = (cause: unknown) => { if (!model.signal.aborted) setError(cause instanceof Error ? cause.message : "objectives_unavailable"); };
  const clear = () => setError(null);
  return <LaunchRosterProvider value={model.models}><div className="objectives-host-commodore-rail">
    <Select value={tab} label={t("objectives.commodore.name")} onChange={setTab} options={[
      { value: "goals", label: t("objectives.commodore.conversation.goals") },
      { value: "directive", label: t("objectives.commodore.tabs.directive") },
      { value: "intel", label: t("objectives.commodore.tabs.intel") },
      { value: "settings", label: t("objectives.commodore.tabs.settings") },
    ]} />
    {error ? <p role="alert">{error}</p> : null}
    {tab === "goals" ? <HostObjectives context={context} /> : view ? <fieldset disabled={!context.canWrite()} className="objectives-host-commodore objectives-commodore-body objectives-commodore-conversation-tab" style={{ border: 0, margin: 0, minWidth: 0 }}>
      {tab === "directive" ? <CommodoreDirective t={t} theaterId={theaterId} directive={view.state.directive} active={view.active} onFail={fail} onClear={clear} /> : null}
      {tab === "intel" ? <CommodoreIntel t={t} theaterId={theaterId} intel={view.state.intel} sources={view.state.sources} onFail={fail} onClear={clear} /> : null}
      {tab === "settings" ? <CommodoreSettings t={t} language={context.language} theaterId={theaterId} view={view} onFail={fail} onClear={clear} /> : null}
    </fieldset> : <p role="status">{snapshot.error ?? t("objectives.results.loading")}</p>}
  </div></LaunchRosterProvider>;
}

export const objectiveHostSurfaces: readonly HostSurfaceDescriptor[] = [
  { id: "commodore", slot: "conversation", role: "commodore", render: (context) => <HostCommodore context={context} /> },
  { id: "commander", slot: "conversation", role: "commander", render: (context) => <HostCommander context={context} /> },
  { id: "objectives", slot: "objectives", render: (context) => context.selection.role === "commodore" ? <HostCommodoreRail context={context} /> : <HostObjectives context={context} /> },
];
