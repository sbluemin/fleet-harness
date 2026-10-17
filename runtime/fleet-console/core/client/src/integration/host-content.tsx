import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { HostOperationSummary, HostSurfaceContext, HostSurfaceNavigation, HostSurfaceOperations } from "@fleet-console/sdk/host-context";
import type { AgentConversationProps, AgentChatTranscriptProps } from "@fleet-console/sdk/components/agent-chat-transcript";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";
import { AgentConversation, AgentChatTranscript } from "../../../../features/execution/client/agent/index.js";
import { HostAgentConversation } from "../../../../features/execution/client/agent/chat/host-conversation.js";
import { ChatHostProvider } from "../../../../features/execution/client/agent/chat/chat-host-context.js";
import type { ArenaInsets } from "../../../../features/workspace/client/conversation/arena-insets.js";
import { HostWorkspaceLocation, HostWorkspaceState } from "../../../../features/workspace/client/sidebar/host-workspace-sidebar.js";
import { useT } from "../i18n/index.js";
import type { PluginRegistry } from "./plugin-registry.js";
import type { HostWorkspaceBinding } from "./use-host-workspace.js";
import "./host-content.css";

const NO_OPERATIONS: readonly HostOperationSummary[] = Object.freeze([]);

const MESSAGES = {
  en: { unstarted: "This objective has not started yet. Plan and commence it from Objectives.", files: "Files", objectives: "Objectives", quota: "Usage limits", unsupported: "This tool is not available for the selected computer.", readOnly: "Read-only observation — acquire control to send messages.", upload: "Image upload is unavailable here. Existing attachments can still be viewed.", tools: "Conversation tools", manageCommodore: "Manage Commodore", localOnly: "App settings and other local-only tools are available after returning to this computer." },
  ko: { unstarted: "아직 시작하지 않은 목표입니다. 목표에서 계획하고 개시하세요.", files: "파일", objectives: "목표", quota: "사용 한도", unsupported: "선택한 컴퓨터에서는 이 도구를 사용할 수 없습니다.", readOnly: "읽기 전용 관찰입니다. 메시지를 보내려면 제어권이 필요합니다.", upload: "이곳에서는 이미지 업로드를 지원하지 않습니다. 기존 첨부는 볼 수 있습니다.", tools: "대화 도구", manageCommodore: "사령관 관리", localOnly: "앱 설정 등 로컬 전용 도구는 이 컴퓨터로 돌아온 뒤 사용할 수 있습니다." },
} as const;

/** 기존 로컬 plugin.install은 건드리지 않는다. 등록된 host-aware factory에만 명시 context를 건넨다. */
export function HostContent({ binding, registry, insets, language, openNewOperation = null }: {
  readonly binding: HostWorkspaceBinding; readonly registry: PluginRegistry; readonly insets: ArenaInsets; readonly language: "en" | "ko";
  /** 선택한 원격 컴퓨터의 Quick Launch 회차를 연다. 로컬 Quick Launch로 대신하지 않는다. */
  readonly openNewOperation?: (() => unknown) | null;
}) {
  const snapshot = useSyncExternalStore(binding.workspace.subscribe, binding.workspace.getSnapshot, binding.workspace.getSnapshot);
  const transport = binding.getSelectedTransport();
  const host = snapshot.hosts.find((candidate) => candidate.hostKey === snapshot.selection.hostKey);
  const t = useMemo(() => createTranslator(MESSAGES, language), [language]);
  const coreT = useT();
  const [tab, setTab] = useState<"files" | "objectives">("files");
  const contexts = useMemo(() => {
    const out = new Map<string, HostSurfaceContext>();
    if (!transport || !host) return out;
    const api = createClientCapabilities(undefined, transport).api;
    const events = binding.events(transport);
    const generation = snapshot.selectionGeneration;
    const selection = snapshot.selection;
    const chat = {
      Conversation: (props: AgentConversationProps) => <ChatHostProvider value={transport}><AgentConversation {...props} /></ChatHostProvider>,
      Transcript: (props: AgentChatTranscriptProps) => <ChatHostProvider value={transport}><AgentChatTranscript {...props} /></ChatHostProvider>,
    };
    const live = () => {
      const current = binding.workspace.getSnapshot();
      return !transport.scope.signal.aborted && current.selectionGeneration === generation && current.selection.hostKey === selection.hostKey;
    };
    const canWrite = () => live() && binding.workspace.getSnapshot().canWrite;
    const currentHost = () => binding.workspace.getSnapshot().hosts.find((candidate) => candidate.hostKey === selection.hostKey);
    // 탐색은 이 회차가 고정한 host·Theater 안에서만 선택을 바꾼다. 다른 컴퓨터·Theater로 넘어가는 경로가 아니다.
    const navigation: HostSurfaceNavigation = {
      focusOperation: async (operationId) => {
        if (!live() || selection.theaterId === null) throw new Error("stale_host_scope");
        const operations = currentHost()?.operations ?? [];
        const found = operations.find((operation) => operation.id === operationId);
        // 원격 선택은 최상위 agent 대화만 받는다. 하위 Operation은 공개된 부모로 올린다.
        const root = found?.parentOperationId ? operations.find((operation) => operation.id === found.parentOperationId) : found;
        if (!root || root.theaterId !== selection.theaterId) throw new Error("operation_outside_theater");
        await binding.workspace.activateConversation({ hostKey: selection.hostKey, theaterId: root.theaterId, role: "commander", operationId: root.id });
      },
      focusObjective: async (objectiveId) => {
        if (!live() || selection.theaterId === null) throw new Error("stale_host_scope");
        // 목표의 실재·Theater·시작 여부는 workspace가 고정 transport로 다시 확인한다.
        await binding.workspace.activateObjective({ hostKey: selection.hostKey, theaterId: selection.theaterId, role: "commander", operationId: objectiveId });
      },
      openNewOperation: () => {
        if (!live()) return;
        openNewOperation?.();
      },
    };
    const operations: HostSurfaceOperations = {
      getSnapshot: () => (live() ? currentHost()?.operations ?? NO_OPERATIONS : NO_OPERATIONS),
      subscribe: (listener) => {
        if (transport.scope.signal.aborted) return () => undefined;
        const off = binding.workspace.subscribe(listener);
        const stop = () => off();
        transport.scope.signal.addEventListener("abort", stop, { once: true });
        return () => { transport.scope.signal.removeEventListener("abort", stop); off(); };
      },
    };
    for (const id of ["execution", ...registry.plugins.map((plugin) => plugin.id)]) out.set(id, {
      // 원장·결정·입력창 조립은 실행 기능의 host-bound 대화가 맡는다. 플러그인은 보드 사실과 동작만 넘긴다.
      selection, transport, api, events, chat, OperationConversation: HostAgentConversation, canWrite, language, hostLabel: host.label, navigation, operations,
      state: binding.surfaceState(id, transport), readResource: (path, signal) => binding.readResource(transport, path, signal),
    });
    return out;
  }, [binding, registry, transport, snapshot.selectionGeneration, language, host?.label, openNewOperation]);
  // 시작하지 않은 목표를 고르면 계획·개시가 있는 목표 탭을 앞에 세운다. 다른 탭을 고른 사용자의 선택은 다음 목표 전까지 둔다.
  const selection = snapshot.selection;
  const unstartedObjectiveId = host && selection.role === "commander"
    && !host.operations.some((operation) => operation.id === selection.operationId && operation.theaterId === selection.theaterId)
    && host.objectives?.some((objective) => objective.id === selection.operationId && objective.theaterId === selection.theaterId && !objective.started)
    ? `${host.hostKey}:${selection.operationId}` : null;
  useEffect(() => { if (unstartedObjectiveId) setTab("objectives"); }, [unstartedObjectiveId]);
  if (!transport || !host || snapshot.foreground === null) return <section className="host-bound-content" style={{ left: insets.left }}><HostWorkspaceState hosts={binding.workspace} t={coreT} /></section>;
  if (snapshot.selection.theaterId === null) return <section className="host-bound-content" style={{ left: insets.left }}><div><HostWorkspaceLocation hosts={binding.workspace} t={coreT} /><p>{coreT("hosts.workspace.selectConversation")}</p></div></section>;
  const surfaces = registry.plugins.flatMap((plugin) => (plugin.hostSurfaces ?? []).map((surface) => ({ pluginId: plugin.id, surface })));
  const conversation = surfaces.find(({ surface }) => surface.slot === "conversation" && surface.role === snapshot.selection.role);
  const rail = surfaces.find(({ surface }) => surface.slot === tab);
  const quota = surfaces.find(({ surface }) => surface.slot === "quota");
  const selectedOperation = host.operations.find((operation) => operation.id === snapshot.selection.operationId && operation.theaterId === snapshot.selection.theaterId);
  // 실행 Operation이 없고 확인된 목표만 있는 선택은 아직 시작하지 않은 목표다. 대화 본문으로 꾸미지 않는다.
  const selectedObjective = selectedOperation ? undefined : host.objectives?.find((objective) => objective.id === snapshot.selection.operationId && objective.theaterId === snapshot.selection.theaterId);
  const title = selectedOperation?.title ?? selectedObjective?.title ?? "";
  return <section className="host-bound-content" style={{ left: insets.left }} data-host-key={host.hostKey} data-host-epoch={host.epoch}>
    <div className="host-bound-conversation">
      <header className="host-bound-header">
        <HostWorkspaceLocation hosts={binding.workspace} t={coreT} />
        <div className="host-bound-quota" key={`${host.hostKey}:${snapshot.selectionGeneration}:${host.epoch}`}>
          <PluginErrorBoundary>{quota ? quota.surface.render(contexts.get(quota.pluginId)!) : <span role="status">{t("unsupported")}</span>}</PluginErrorBoundary>
        </div>
      </header>
      <div className="host-bound-body" key={`${host.hostKey}:${snapshot.selectionGeneration}:${host.epoch}`}>
        {/* 역할이 맞는 플러그인 표면이 있으면 그것이 본문을 맡는다(목표의 계획·개시 흐름 포함). 없을 때만 기존 대화로 물러나되,
            시작하지 않은 목표를 실행 중 대화로 보이게 하지 않는다. */}
        <PluginErrorBoundary>{conversation ? conversation.surface.render(contexts.get(conversation.pluginId)!)
          : snapshot.selection.role === "commander" && selectedObjective && !selectedObjective.started ? <p className="host-bound-unstarted" role="status">{t("unstarted")}</p>
          : snapshot.selection.role === "commander" ? <HostAgentConversation context={contexts.get("execution")!} title={title} readOnlyLabel={t("readOnly")} uploadUnsupported={t("upload")} />
          : <p role="status">{t("unsupported")}</p>}</PluginErrorBoundary>
      </div>
    </div>
    <aside className="host-bound-rail">
      <div className="host-bound-tabs" role="tablist" aria-label={t("tools")}>{(["files", "objectives"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{t(value)}</button>)}</div>
      <div className="host-bound-rail-caption"><HostWorkspaceLocation hosts={binding.workspace} t={coreT} rail />
        {selection.role === "commodore" && surfaces.some(({ surface }) => surface.slot === "objectives") ? <button className="host-bound-manage" type="button" aria-expanded={tab === "objectives"} onClick={() => {
          // 진입은 현재 회차의 보기만 바꾼다. 제어권 획득이나 다른 host 선택을 동반하지 않는다.
          const current = binding.workspace.getSnapshot();
          if (transport.scope.signal.aborted || current.selectionGeneration !== snapshot.selectionGeneration || current.selection.hostKey !== selection.hostKey) return;
          setTab("objectives");
        }}>{t("manageCommodore")}</button> : null}
      </div>
      <div className="host-bound-pane" key={`${host.hostKey}:${snapshot.selectionGeneration}:${host.epoch}:${tab}`}>
        <PluginErrorBoundary>{rail ? rail.surface.render(contexts.get(rail.pluginId)!) : <p role="status">{t("unsupported")}</p>}</PluginErrorBoundary>
      </div>
      <small className="host-bound-local-notice">{t("localOnly")}</small>
    </aside>
  </section>;
}
