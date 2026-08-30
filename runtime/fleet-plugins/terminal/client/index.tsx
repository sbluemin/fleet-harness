import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { agentAttentionNotification, agentOperationKind, agentPlugin, agentSettingsSection, generalSettingsSection, harnessSettingsSection } from "./agent/index.js";
import { globalShellEntry } from "./global-shell/rail-panel.js";
import { PersistentShellHost, shellSurface } from "./shell/index.js";
import { preloadTerminalFallbackFonts } from "./shared/terminal-fallback-fonts.js";
import { connectTerminalSettings } from "./shared/terminal-preferences.js";
import "./assets/fonts/symbols-nerd-font-mono.css";
/* 한글 등폭 폴백의 실체. unicode-range로 쪼갠 청크판(400.css/700.css)이 아니라 한글 서브셋
   통짜판을 쓴다 — WebGL glyph atlas는 글리프를 처음 그릴 때 래스터화해 캐시하는데, 그 atlas는
   같은 설정의 터미널들이 모듈 레벨에서 공유하므로 한 터미널이 비울 수 없다(terminal-surface의
   clearTextureAtlas 주석). 즉 폰트가 늦게 도착하면 첫 한글이 폴백 글리프로 구워져 그대로 남는다.
   통짜 @font-face라야 open 직전에 한 번 선대기해 그 경합을 없앨 수 있다. */
import "@fontsource/nanum-gothic-coding/korean-400.css";
import "@fontsource/nanum-gothic-coding/korean-700.css";

const AGENT_OPERATION_TYPES = new Set(["agent"]);

const terminalPlugin = definePlugin({
  id: "terminal",
  operationKinds: [agentOperationKind],
  settingsSections: [harnessSettingsSection, generalSettingsSection, agentSettingsSection],
  notificationKinds: [agentAttentionNotification],
  railEntries: [globalShellEntry],
  expandedSurfaces: [shellSurface],
  // Shell은 한 번 열린 뒤 슬롯을 닫아도 xterm과 WebSocket을 보존한다. 표면 본문은 portal
  // 목적지만 내주고, 실제 소유자는 콘솔 수명에 붙는 이 상주 기여다.
  persistentComponents: [{ id: "terminal-shell-host", render: (ctx) => <PersistentShellHost language={ctx.language} theme={ctx.theme} /> }],
  install: (ctx) => { void preloadTerminalFallbackFonts(); connectTerminalSettings(ctx.settings); return agentPlugin.install?.(ctx); },
  closeOperation: async (operationId) => {
    const operation = await fetchOperation(operationId);
    if (operation && AGENT_OPERATION_TYPES.has(operation.type)) {
      await agentPlugin.closeOperation?.(operationId);
    }
  },
  // 팔레트 등 호스트 경유 resume 요청을 agent 구현으로 전달한다 — 래퍼가 삼키면
  // 호스트는 hook 부재로 판단해 포커스 폭백만 수행한다. Shell은 Operation이 아니므로
  // 여기에 오지 않는다(비영속이라 되살릴 휴면 자체가 없다).
  resumeOperation: async (operationId) => {
    await agentPlugin.resumeOperation?.(operationId);
  },
  // Quick Launch 멘션 전달. 대상 자체가 messageableOperationTypes로 agent 타입에 한정되므로
  // shell 판별 조회 없이 agent 구현으로 곧장 넘긴다 — 래퍼가 hook을 삼키면 호스트는 부재로 읽는다.
  // 타입 선언은 agent 구현의 것을 그대로 실어 두 목록이 갈라질 자리를 없앤다.
  messageableOperationTypes: agentPlugin.messageableOperationTypes,
  messageOperation: async (operationId, text, attachmentIds) => {
    // 옵셔널 체인은 구현 소실을 무음 전달 성공으로 만든다 — 없으면 던져서 컴포저가 실패를 말하게 한다.
    const deliver = agentPlugin.messageOperation;
    if (!deliver) throw new Error("terminal_message_unsupported");
    await deliver(operationId, text, attachmentIds);
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
  launch: async (ctx) => agentPlugin.launch?.(ctx) ?? { id: "" },
  renderLaunchIcon: (kind) => agentPlugin.renderLaunchIcon?.(kind),
});

export const operationKinds = [agentOperationKind] as const;
export const settingsSections = [harnessSettingsSection, generalSettingsSection, agentSettingsSection] as const;
export const notificationKinds = [agentAttentionNotification] as const;
export const plugins = [terminalPlugin] as const;

async function fetchOperation(operationId: string): Promise<{ readonly type: string } | null> {
  const response = await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`);
  if (!response.ok) return null;
  const payload = await response.json() as { readonly operation?: { readonly type?: unknown } };
  return typeof payload.operation?.type === "string" ? { type: payload.operation.type } : null;
}
