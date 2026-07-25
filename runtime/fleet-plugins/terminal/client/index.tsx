import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { agentAttentionNotification, agentOperationKind, agentPlugin, agentSettingsSection, generalSettingsSection } from "./agent/index.js";
import { carrierSettingsSection } from "./carriers/section.js";
import { globalShellPanel } from "./global-shell/rail-panel.js";
import { shellOperationKind, shellPlugin } from "./shell/index.js";
import { preloadSymbolsNerdFontMono } from "./shared/symbols-font.js";
import { connectTerminalSettings } from "./shared/terminal-prefs-store.js";
import "./assets/fonts/symbols-nerd-font-mono.css";
import "./carriers/styles.css";

const AGENT_OPERATION_TYPES = new Set(["agent"]);

export const terminalPlugin = definePlugin({
  id: "terminal",
  operationKinds: [shellOperationKind, agentOperationKind],
  settingsSections: [generalSettingsSection, agentSettingsSection, carrierSettingsSection],
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
  launch: async (ctx) => ctx.kind.type === "shell"
    ? shellPlugin.launch?.(ctx) ?? { id: "" }
    : agentPlugin.launch?.(ctx) ?? { id: "" },
  renderLaunchIcon: (kind) => kind.type === "shell" ? shellPlugin.renderLaunchIcon?.(kind) : agentPlugin.renderLaunchIcon?.(kind),
});

export const operationKinds = [shellOperationKind, agentOperationKind] as const;
export const settingsSections = [generalSettingsSection, agentSettingsSection, carrierSettingsSection] as const;
export const notificationKinds = [agentAttentionNotification] as const;
export const plugins = [terminalPlugin] as const;

async function fetchOperation(operationId: string): Promise<{ readonly type: string } | null> {
  const response = await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`);
  if (!response.ok) return null;
  const payload = await response.json() as { readonly operation?: { readonly type?: unknown } };
  return typeof payload.operation?.type === "string" ? { type: payload.operation.type } : null;
}
