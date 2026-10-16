import { useMemo, useState, useSyncExternalStore } from "react";
import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { HostSurfaceContext } from "@fleet-console/sdk/host-context";
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

const MESSAGES = {
  en: { files: "Files", objectives: "Objectives", quota: "Usage limits", unsupported: "This tool is not available for the selected computer.", readOnly: "Read-only observation — acquire control to send messages.", upload: "Image upload is unavailable here. Existing attachments can still be viewed.", tools: "Conversation tools", localOnly: "Other tools and settings are available after returning to this computer." },
  ko: { files: "파일", objectives: "목표", quota: "사용 한도", unsupported: "선택한 컴퓨터에서는 이 도구를 사용할 수 없습니다.", readOnly: "읽기 전용 관찰입니다. 메시지를 보내려면 제어권이 필요합니다.", upload: "이곳에서는 이미지 업로드를 지원하지 않습니다. 기존 첨부는 볼 수 있습니다.", tools: "대화 도구", localOnly: "다른 도구와 설정은 이 컴퓨터로 돌아온 뒤 사용할 수 있습니다." },
} as const;

/** 기존 로컬 plugin.install은 건드리지 않는다. 등록된 host-aware factory에만 명시 context를 건넨다. */
export function HostContent({ binding, registry, insets, language }: { readonly binding: HostWorkspaceBinding; readonly registry: PluginRegistry; readonly insets: ArenaInsets; readonly language: "en" | "ko" }) {
  const snapshot = useSyncExternalStore(binding.workspace.subscribe, binding.workspace.getSnapshot, binding.workspace.getSnapshot);
  const transport = binding.getSelectedTransport();
  const host = snapshot.hosts.find((candidate) => candidate.hostKey === snapshot.selection.hostKey);
  const t = useMemo(() => createTranslator(MESSAGES, language), [language]);
  const coreT = useT();
  const [tab, setTab] = useState<"files" | "objectives" | "quota">("objectives");
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
    const canWrite = () => {
      const current = binding.workspace.getSnapshot();
      return !transport.scope.signal.aborted && current.selectionGeneration === generation && current.selection.hostKey === selection.hostKey && current.canWrite;
    };
    for (const id of ["execution", ...registry.plugins.map((plugin) => plugin.id)]) out.set(id, {
      selection, transport, api, events, chat, canWrite, language, hostLabel: host.label,
      state: binding.surfaceState(id, transport), readResource: (path, signal) => binding.readResource(transport, path, signal),
    });
    return out;
  }, [binding, registry, transport, snapshot.selectionGeneration, language, host?.label]);
  if (!transport || !host || snapshot.foreground === null) return <section className="host-bound-content" style={{ left: insets.left }}><HostWorkspaceState hosts={binding.workspace} t={coreT} /></section>;
  if (snapshot.selection.theaterId === null) return <section className="host-bound-content" style={{ left: insets.left }}><div><HostWorkspaceLocation hosts={binding.workspace} t={coreT} /><p>{coreT("hosts.workspace.selectConversation")}</p></div></section>;
  const surfaces = registry.plugins.flatMap((plugin) => (plugin.hostSurfaces ?? []).map((surface) => ({ pluginId: plugin.id, surface })));
  const conversation = surfaces.find(({ surface }) => surface.slot === "conversation" && surface.role === snapshot.selection.role);
  const rail = surfaces.find(({ surface }) => surface.slot === tab);
  const title = host.operations.find((operation) => operation.id === snapshot.selection.operationId)?.title ?? "";
  return <section className="host-bound-content" style={{ left: insets.left }} data-host-key={host.hostKey} data-host-epoch={host.epoch}>
    <div className="host-bound-conversation">
      <HostWorkspaceLocation hosts={binding.workspace} t={coreT} />
      <div className="host-bound-body" key={`${host.hostKey}:${snapshot.selectionGeneration}:${host.epoch}`}>
        <PluginErrorBoundary>{snapshot.selection.role === "commander" ? <HostAgentConversation context={contexts.get("execution")!} title={title} readOnlyLabel={t("readOnly")} uploadUnsupported={t("upload")} />
          : conversation ? conversation.surface.render(contexts.get(conversation.pluginId)!) : <p role="status">{t("unsupported")}</p>}</PluginErrorBoundary>
      </div>
    </div>
    <aside className="host-bound-rail">
      <div className="host-bound-tabs" role="tablist" aria-label={t("tools")}>{(["objectives", "files", "quota"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{t(value)}</button>)}</div>
      <div className="host-bound-pane" key={`${host.hostKey}:${snapshot.selectionGeneration}:${host.epoch}:${tab}`}>
        <PluginErrorBoundary>{rail ? rail.surface.render(contexts.get(rail.pluginId)!) : <p role="status">{t("unsupported")}</p>}</PluginErrorBoundary>
      </div>
      <small className="host-bound-local-notice">{t("localOnly")}</small>
    </aside>
  </section>;
}
