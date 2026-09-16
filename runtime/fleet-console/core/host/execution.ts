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
  // Operation Browser 의 스크린샷 첨부 — 패널이 OS 클립보드에 올린 이미지를 터미널 CLI 가 읽도록 Ctrl+V 한 번을
  // PTY 에 넣는다. 줄 종결자는 없다(보내는 순간은 사람이 정한다).
  const unbindBrowserPaste = ctx.host.browserMcp?.bindTerminalPaste((operationId) => runtime.write(operationId, "\u0016"));
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
  // Console Use 확장면의 분석가 묶음 — 서버가 만든 같은 객체에 채운다.
  if (ctx.consoleSurface) Object.assign(ctx.consoleSurface, { analystAsk: analysis.ask, analystArtifacts: analysis.artifacts } satisfies Partial<NonNullable<typeof ctx.consoleSurface>>);
  const sessionWatch = registerExperimentRoutes(ctx, {});
  const agentLaunchKinds = await registerAgentRoutes(ctx, runtime, {
    globalOptionsService: infraServices.globalOptionsService,
    readAiGatewaySettings: aiGatewayStore.read,
    aiGateway: {
      routePath: `${ctx.basePath}/${AI_GATEWAY_ROUTE_SEGMENT}`,
      origin: () => ctx.host.server.origin(),
      compactHookToken: aiGatewayRuntime.compactHookToken,
    },
    // 턴의 끝은 브라우저의 에이전트 사용 세션도 닫는다 — 호출 단위가 아니라 턴 단위로 「사용 중」이 켜져 있게.
    onTurnEnded: (operationId) => sessionWatch.onTurnEnded(operationId),
    // 턴이 멈추면(정상·중단 모두) 에이전트 사용 표식을 내린다. Computer Use 는 기기 소유도 함께 놓는다 — 표식만
    // 내리고 잡고 있으면 공유 화면이 조용히 살아 있는 셈이다. 세 호출 모두 멱등이라 겹쳐 불려도 된다.
    onTurnSettled: (operationId) => { ctx.host.browserMcp?.endAgentSession(operationId); ctx.host.computerUseMcp?.revokeOperation(operationId); ctx.host.consoleUse.endOperationUse?.(operationId); },
  });
  return agentLaunchKinds;
}

function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string | null } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown };
  return typeof event.operationId === "string" && event.pluginId === null;
}
