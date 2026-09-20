import { startAiGateway } from "../../../features/ai-gateway/host/start.js";

/** Console이 제어 보유자 변화를 알리는 채널. 이름은 core/host/access-control-contract.ts와 한 벌이다. */
const CONTROL_HOLDER_EVENT_CHANNEL = "control:holder";

import type { ConsoleRuntimeContext } from "../../../features/execution/host/context.js";
import { registerWsHandler } from "../../../features/execution/host/context.js";

import { AI_GATEWAY_ROUTE_SEGMENT } from "../../../features/ai-gateway/host/routes.js";
import { registerAnalysisRoutes } from "../../../features/analyst/host/analysis-routes.js";
import { registerExperimentRoutes } from "../../../features/execution/host/agent/experiments-routes.js";
import { registerAgentRoutes } from "../../../features/execution/host/agent/routes.js";
import { createTerminalRuntime } from "../../../features/execution/host/terminal/index.js";
import { registerShellRoutes } from "../../../features/execution/host/terminal/shell.js";
import { registerTerminalSettingsRoutes } from "../../../features/settings/host/execution-settings-routes.js";

export const CORE_AGENT_SENSITIVE_FIELDS = ["cwd", "canonicalCwd", "providerTitle", "transcriptPath", "token", "ticket", "prompt", "persona", "toolAllowlist"] as const;
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";

export async function startConsoleExecution(ctx: ConsoleRuntimeContext, organize: Pick<import("../../../features/console-use/host/console-use.js").ConsoleUseActions, "rename" | "group">) {
  const { store: aiGatewayStore, wireLog, runtime: aiGatewayRuntime } = startAiGateway(ctx);
  registerTerminalSettingsRoutes(ctx, {
    agentOptionsService: ctx.agentOptions,
    aiGatewayStore,
    wireLogRuntime: wireLog,
  });
  const runtime = createTerminalRuntime(ctx);
  // Operation Browser 의 스크린샷 첨부 — 서버가 올린 이미지를 CLI 가 읽도록 Windows 는 Alt+V(ESC v), 나머지는 Ctrl+V 를
  // PTY 에 넣는다. 줄 종결자는 없다(보내는 순간은 사람이 정한다).
  const unbindBrowserPaste = ctx.host.browserMcp?.bindTerminalPaste((operationId) => runtime.write(operationId, process.platform === "win32" ? "\x1bv" : "\u0016"));
  if (unbindBrowserPaste) ctx.host.lifecycle.registerCleanup(unbindBrowserPaste);
  registerWsHandler(ctx, "/", runtime.handleUpgrade, { method: "GET", path: "", summary: "Open the Terminal WebSocket transport.", category: "Console Execution", gate: "one-use-ticket", transport: "websocket" });
  ctx.host.lifecycle.registerCleanup(() => runtime.stop());
  const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
    if (!isOperationDeletedEvent(payload) || payload.pluginId !== null) return;
    runtime.terminate(payload.operationId);
    // 브라우저 컨텍스트(탭·쿠키)도 Operation 과 함께 사라진다 — 남겨 두면 엔진이 유휴 종료에 닿지 못한다.
    ctx.host.browserMcp?.revokeOperation(payload.operationId);
  });
  ctx.host.lifecycle.registerCleanup(unsubscribeDelete);
  /**
   * 제어 보유자가 바뀌면 이미 붙어 있는 터미널 소켓도 등급을 다시 받아야 한다. 티켓 발급
   * 시점의 판정만으로는 그때 이미 열려 있던 터미널이 옛 등급 그대로 남아, 회수한 뒤에도
   * 읽기 전용에 갇히거나 넘긴 뒤에도 계속 입력이 간다.
   */
  const unsubscribeControl = ctx.host.events.subscribe(CONTROL_HOLDER_EVENT_CHANNEL, () => { runtime.renegotiateSockets(); });
  ctx.host.lifecycle.registerCleanup(unsubscribeControl);
  registerShellRoutes(ctx, runtime);
  const analysis = registerAnalysisRoutes(ctx, {
    // 분석가는 이제 게이트웨이 위에서 돈다. 고를 수 있는 모델은 사용자가 켠 선별이다.
    readAiGatewaySettings: aiGatewayStore.read,
  });
  const sessionWatch = registerExperimentRoutes(ctx, {});
  const agent = await registerAgentRoutes(ctx, runtime, {
    organize,
    agentOptionsService: ctx.agentOptions,
    readAiGatewaySettings: aiGatewayStore.read,
    aiGateway: {
      routePath: `${ctx.basePath}/${AI_GATEWAY_ROUTE_SEGMENT}`,
      origin: () => ctx.host.server.origin(),
      compactHookToken: aiGatewayRuntime.compactHookToken,
      modHookToken: aiGatewayRuntime.modHookToken,
    },
    // 턴의 끝은 브라우저의 에이전트 사용 세션도 닫는다 — 호출 단위가 아니라 턴 단위로 「사용 중」이 켜져 있게.
    onTurnEnded: (operationId) => sessionWatch.onTurnEnded(operationId),
    // 턴이 멈추면(정상·중단 모두) 에이전트 사용 표식을 내린다. Computer Use 는 기기 소유도 함께 놓는다 — 표식만
    // 내리고 잡고 있으면 공유 화면이 조용히 살아 있는 셈이다. 세 호출 모두 멱등이라 겹쳐 불려도 된다.
    onTurnSettled: (operationId) => { ctx.host.browserMcp?.endAgentSession(operationId); ctx.host.computerUseMcp?.revokeOperation(operationId); ctx.host.consoleUse.endOperationUse?.(operationId); },
  });
  return { launchKinds: agent.launchKinds, actions: { ...agent.actions, analystAsk: analysis.ask, analystArtifacts: analysis.artifacts, analystState: analysis.state } };
}

function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string | null } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown };
  return typeof event.operationId === "string" && event.pluginId === null;
}
