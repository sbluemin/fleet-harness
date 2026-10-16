import type { FleetPluginHostCapabilities, ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";

interface GatewayHostContext {
  readonly host: {
    readonly lifecycle: Pick<FleetPluginHostCapabilities["lifecycle"], "registerCleanup">;
  };
  readonly dataDir: string;
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
  createAiGatewayRouter,
  createCursorDiagnosticLog,
  createFailureJournal,
  createRequestTimingJournal,
  createClaudeCodexCompactionStore,
  readAntigravitySubscriptionToken,
  readCursorSubscriptionToken,
} from "@fleet-console/ai-gateway";
import type { AiGatewayRouteDeps } from "@fleet-console/ai-gateway";

export { AI_GATEWAY_ROUTE_SEGMENT } from "@fleet-console/ai-gateway";

export type ConsoleAiGatewayRouteDeps = Omit<
  AiGatewayRouteDeps,
  "originator" | "readModelOverride" | "readAuth" | "readCursorToken" | "readXaiToken" | "readAntigravityToken" | "renewAntigravityToken" | "readMuseCodeAuth"
> & Partial<Pick<AiGatewayRouteDeps, "readAuth" | "readCursorToken" | "readXaiToken" | "readAntigravityToken" | "renewAntigravityToken" | "readMuseCodeAuth" | "assignRouting">>;

export function registerAiGatewayRoutes(
  ctx: GatewayHostContext,
  deps: ConsoleAiGatewayRouteDeps = {},
): { readonly compactHookToken: string; readonly modHookToken: string } {
  const ownedDiagnostics = deps.cursorDiagnostics
    ? undefined
    : createCursorDiagnosticLog(path.join(
        ctx.dataDir,
        "ai-gateway",
      ));
  // Always on, unlike the wire log: a failed turn is the one event that otherwise leaves no
  // trace, and a post-commit failure reaches the user as a single SSE frame nobody can retrieve.
  const ownedFailureJournal = deps.failureJournal
    ? undefined
    : createFailureJournal({
        filePath: path.join(
          ctx.dataDir,
          "ai-gateway",
          "failures.jsonl",
        ),
      });
  const ownedRequestTiming = deps.requestTiming
    ? undefined
    : createRequestTimingJournal({
        filePath: path.join(
          ctx.dataDir,
          "ai-gateway",
          "request-timing.jsonl",
        ),
      });
  const compactHookToken = randomUUID();
  const modHookToken = randomUUID();
  const compactionStore = createClaudeCodexCompactionStore({
    directory: path.join(ctx.dataDir, "ai-gateway"),
  });
  const router = createAiGatewayRouter({
    ...deps,
    originator: "fleet-console",
    compactionStore,
    compactionHookToken: compactHookToken,
    modHookToken,
    // 호출 시점의 노출을 읽는다 — 스냅숏이 아니라 지금 켜져 있는 모델이 답이 된다.
    assignRouting: deps.assignRouting,
    failureJournal: deps.failureJournal ?? ownedFailureJournal?.write,
    requestTiming: deps.requestTiming ?? ownedRequestTiming?.write,
    // 자격증명 조달은 호스트 결정이다 — Console은 core-ai-gateway가 export한 기본 reader를 주입한다.
    // Codex·xAI 자격은 Console 로그인(start.ts)이 주입한다. 주입이 없으면 자격도 없다 — 벤더 파일로 물러나지 않는다.
    readAuth: deps.readAuth ?? (() => null),
    readCursorToken: deps.readCursorToken ?? (() => readCursorSubscriptionToken()),
    readXaiToken: deps.readXaiToken ?? (() => null),
    readAntigravityToken: deps.readAntigravityToken ?? (() => readAntigravitySubscriptionToken()),
    renewAntigravityToken: deps.renewAntigravityToken
      ?? (() => readAntigravitySubscriptionToken({ forceRenew: true })),
    readModelOverride: () => process.env[AI_GATEWAY_MODEL_ENV],
    cursorDiagnostics: deps.cursorDiagnostics ?? ownedDiagnostics?.write,
  });
  ctx.host.lifecycle.registerCleanup(async () => {
    router.dispose();
    await ownedDiagnostics?.flush();
    await ownedFailureJournal?.flush();
    await ownedRequestTiming?.flush();
  });
  ctx.registerRouter(AI_GATEWAY_ROUTE_SEGMENT, router.handle, [
    { method: "*", path: "/api/hello", summary: "Read the AI Gateway health response.", category: "Console Execution", gate: "loopback", transport: "http" },
    { method: "*", path: "/v1/models", summary: "Proxy the AI Gateway model listing.", category: "Console Execution", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/messages", summary: "Proxy an Anthropic Messages request through the AI Gateway.", category: "Console Execution", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/compact-events", summary: "Receive a Claude compact lifecycle event.", category: "Console Execution", gate: "lock-token", transport: "http" },
    { method: "POST", path: "/v1/fleet/routing/assign", summary: "Assign a model and reasoning effort to one delegated run.", category: "Console Execution", gate: "lock-token", transport: "http" },
  ]);
  return { compactHookToken, modHookToken };
}
