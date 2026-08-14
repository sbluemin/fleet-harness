import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { agentAttentionNotification, agentOperationKind, agentPlugin, agentSettingsSection, generalSettingsSection } from "./agent/index.js";
import { globalShellPanel } from "./global-shell/rail-panel.js";
import { shellOperationKind, shellPlugin } from "./shell/index.js";
import { preloadSymbolsNerdFontMono } from "./shared/symbols-font.js";
import { connectTerminalSettings } from "./shared/terminal-preferences.js";
import "./assets/fonts/symbols-nerd-font-mono.css";

const AGENT_OPERATION_TYPES = new Set(["agent"]);

export const terminalPlugin = definePlugin({
  id: "terminal",
  operationKinds: [shellOperationKind, agentOperationKind],
  settingsSections: [generalSettingsSection, agentSettingsSection],
  notificationKinds: [agentAttentionNotification],
  railPanels: [globalShellPanel],
  install: (ctx) => { void preloadSymbolsNerdFontMono(); connectTerminalSettings(ctx.settings); return agentPlugin.install?.(ctx); },
  closeOperation: async (operationId) => {
    const operation = await fetchOperation(operationId);
    if (operation?.type === "shell") {
      await shellPlugin.closeOperation?.(operationId);
      return;
    }
    if (operation && AGENT_OPERATION_TYPES.has(operation.type)) {
      await agentPlugin.closeOperation?.(operationId);
    }
  },
  // 팔레트 등 호스트 경유 resume 요청을 agent 구현으로 전달한다 — 래퍼가 삼키면
  // 호스트는 hook 부재로 판단해 포커스 폭백만 수행한다(Codex P1).
  resumeOperation: async (operationId) => {
    // 타입 조회 실패(null/예외)는 shell 판별이 불가능하다는 뜻이므로 agent 경로로 넘긴다 —
    // 여기서 조용히 반환하면 호스트의 catch만 삼켜 실패 알림이 어디에도 나가지 않는다(Codex P2).
    // 서버가 404/409로 거절하면 agentPlugin.resumeOperation이 agent.resume-failed를 emit한다.
    let operation: { readonly type: string } | null = null;
    try {
      operation = await fetchOperation(operationId);
    } catch {
      operation = null;
    }
    if (operation?.type === "shell") return;
    await agentPlugin.resumeOperation?.(operationId);
  },
  // Quick Launch 멘션 전달. 대상 자체가 messageableOperationTypes로 agent 타입에 한정되므로
  // shell 판별 조회 없이 agent 구현으로 곧장 넘긴다 — 래퍼가 hook을 삼키면 호스트는 부재로 읽는다.
  // 타입 선언은 agent 구현의 것을 그대로 실어 두 목록이 갈라질 자리를 없앤다.
  messageableOperationTypes: agentPlugin.messageableOperationTypes,
  messageOperation: async (operationId, text) => {
    // 옵셔널 체인은 구현 소실을 무음 전달 성공으로 만든다 — 없으면 던져서 컴포저가 실패를 말하게 한다.
    const deliver = agentPlugin.messageOperation;
    if (!deliver) throw new Error("terminal_message_unsupported");
    await deliver(operationId, text);
  },
  // Quick Launch 이미지 첨부 — agent 전용 능력이라 shell 판별 없이 곧장 넘긴다(멘션 전달과 같은 계약).
  uploadLaunchAttachment: async (file) => {
    const upload = agentPlugin.uploadLaunchAttachment;
    if (!upload) throw new Error("attachment_upload_failed");
    return upload(file);
  },
  discardLaunchAttachment: async (id) => {
    await agentPlugin.discardLaunchAttachment?.(id);
  },
  launch: async (ctx) => ctx.kind.type === "shell"
    ? shellPlugin.launch?.(ctx) ?? { id: "" }
    : agentPlugin.launch?.(ctx) ?? { id: "" },
  renderLaunchIcon: (kind) => kind.type === "shell" ? shellPlugin.renderLaunchIcon?.(kind) : agentPlugin.renderLaunchIcon?.(kind),
});

export const operationKinds = [shellOperationKind, agentOperationKind] as const;
export const settingsSections = [generalSettingsSection, agentSettingsSection] as const;
export const notificationKinds = [agentAttentionNotification] as const;
export const plugins = [terminalPlugin] as const;

async function fetchOperation(operationId: string): Promise<{ readonly type: string } | null> {
  const response = await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`);
  if (!response.ok) return null;
  const payload = await response.json() as { readonly operation?: { readonly type?: unknown } };
  return typeof payload.operation?.type === "string" ? { type: payload.operation.type } : null;
}
