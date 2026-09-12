import path from "node:path";

/** Console이 제어 보유자 변화를 알리는 채널. 이름은 core/host/access-control-contract.ts와 한 벌이다. */
const CONTROL_HOLDER_EVENT_CHANNEL = "control:holder";

import type { ConsoleRuntimeContext } from "./runtime-context.js";
import { registerWsHandler } from "./runtime-context.js";
import { createInfraServices } from "@dotobokuri/core-infra";
import { KIMI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID } from "@dotobokuri/fleet-admiral";
import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  createAiGatewaySettingsStore,
  createProviderAuthService,
  setWireLogTarget,
  wireLogEnabled,
} from "@dotobokuri/core-ai-gateway";
import type { AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";

import { registerAgentRoutes } from "./agent/routes.js";
import { registerAnalysisRoutes } from "./agent/analysis-routes.js";
import { registerExperimentRoutes } from "./agent/experiments-routes.js";
import { AI_GATEWAY_ROUTE_SEGMENT, registerAiGatewayRoutes } from "./ai-gateway/routes.js";
import { registerTerminalSettingsRoutes } from "./agent/settings-routes.js";
import { registerTerminalModelAuthRoutes } from "./ai-gateway/model-auth-routes.js";
import { createTerminalRuntime } from "./terminal/index.js";
import { registerShellRoutes } from "./terminal/shell.js";

function applyWireLog(ctx: ConsoleRuntimeContext, stored: boolean | undefined): void {
  setWireLogTarget(stored === undefined
    ? undefined
    : stored
      ? {
        path: path.join(ctx.dataDir, "ai-gateway", "wire-log.jsonl"),
        maxBytes: DEFAULT_WIRE_LOG_MAX_BYTES,
      }
      : null);
}

function createWireLogRuntime(ctx: ConsoleRuntimeContext) {
  return {
    enabled: wireLogEnabled,
    apply: (stored: boolean | undefined) => applyWireLog(ctx, stored),
  };
}

function applyStoredWireLog(ctx: ConsoleRuntimeContext, read: () => AiGatewayStoredSettings): void {
  try {
    applyWireLog(ctx, read().wireLogEnabled);
  } catch {
    // 손상된 설정은 환경변수의 로깅 대상을 비활성화한 채 기동한다.
    applyWireLog(ctx, false);
  }
}

export const CORE_AGENT_SENSITIVE_FIELDS = ["cwd", "canonicalCwd", "providerTitle", "transcriptPath", "token", "ticket", "prompt", "persona", "toolAllowlist"] as const;
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";

export async function startConsoleExecution(ctx: ConsoleRuntimeContext) {
  const infraServices = createInfraServices();
  const authService = createProviderAuthService({ dataDir: ctx.host.paths.fleetDataDir });
  // AI Gateway 선별의 저장 형태·검증·승계는 core-ai-gateway가 소유한다. 호스트는 이 설정이
  // 예전에 살던 자기 소유 디렉터리만 알려 주고(플러그인 데이터 슬롯), 그 승계 판단은 하지 않는다.
  // Apply the stored target before registering routes so no request can observe an uninitialized mode.
  // dataDir는 호스트의 **유효** Fleet 루트다. 생략하면 core가 실제 홈(`~/.fleet`)으로 떨어져,
  // 격리 루트로 띄운 Console이 사용자의 진짜 설정을 읽고 덮어쓴다.
  const aiGatewayStore = createAiGatewaySettingsStore({
    dataDir: ctx.host.paths.fleetDataDir,
    legacyDir: ctx.legacyDataDir,
  });
  const wireLog = createWireLogRuntime(ctx);
  applyStoredWireLog(ctx, aiGatewayStore.read);
  ctx.host.lifecycle.registerCleanup(() => setWireLogTarget(undefined));
  registerTerminalSettingsRoutes(ctx, {
    globalOptionsService: infraServices.globalOptionsService,
    aiGatewayStore,
    wireLogRuntime: wireLog,
  });
  registerTerminalModelAuthRoutes(ctx, { authService });
  const aiGatewayRuntime = registerAiGatewayRoutes(ctx, {
    readAiGatewaySettings: aiGatewayStore.read,
    readKimiApiKey: () => authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
    readOpencodeApiKey: () => authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
  });
  const runtime = createTerminalRuntime(ctx);
  registerWsHandler(ctx, "/", runtime.handleUpgrade, { method: "GET", path: "", summary: "Open the Terminal WebSocket transport.", category: "Console Execution", gate: "one-use-ticket", transport: "websocket" });
  ctx.host.lifecycle.registerCleanup(() => runtime.stop());
  const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
    if (!isOperationDeletedEvent(payload) || payload.pluginId !== null) return;
    runtime.terminate(payload.operationId);
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
  registerAnalysisRoutes(ctx, {
    // 분석가는 이제 게이트웨이 위에서 돈다. 고를 수 있는 모델은 사용자가 켠 선별이다.
    readAiGatewaySettings: aiGatewayStore.read,
  });
  const sessionWatch = registerExperimentRoutes(ctx, {});
  const agentLaunchKinds = await registerAgentRoutes(ctx, runtime, {
    globalOptionsService: infraServices.globalOptionsService,
    readAiGatewaySettings: aiGatewayStore.read,
    aiGateway: {
      routePath: `${ctx.basePath}/${AI_GATEWAY_ROUTE_SEGMENT}`,
      origin: () => ctx.host.server.origin(),
      compactHookToken: aiGatewayRuntime.compactHookToken,
    },
    onTurnEnded: (operationId) => sessionWatch.onTurnEnded(operationId),
  });
  return agentLaunchKinds;
}

function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string | null } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown };
  return typeof event.operationId === "string" && event.pluginId === null;
}
