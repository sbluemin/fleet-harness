import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
  createAiGatewayRouter,
  createCursorDiagnosticLog,
  createFailureJournal,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
  readXaiSubscriptionToken,
} from "@dotobokuri/core-ai-gateway";
import type { AiGatewayRouteDeps, AiGatewayRouter } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { createDedicatedGatewayPool } from "./ai-gateway-pool.js";
import type { DedicatedGatewayPool } from "./ai-gateway-pool.js";

export {
  MAX_DEDICATED_GATEWAYS,
  PANEL_GATEWAY_HEADER,
  createDedicatedGatewayPool,
} from "./ai-gateway-pool.js";
export type { DedicatedGatewayPool } from "./ai-gateway-pool.js";

export {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
  ANTHROPIC_MESSAGES_URL,
  KIMI_MESSAGES_URL,
  OPENCODE_MESSAGES_URL,
  callerAnthropicCredential,
  createAiGatewayRouter,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
  readXaiSubscriptionToken,
} from "@dotobokuri/core-ai-gateway";
export type {
  AiGatewayRouteDeps,
  AiGatewayRouter,
  CodexSubscriptionAuth,
} from "@dotobokuri/core-ai-gateway";

export type ConsoleAiGatewayRouteDeps = Omit<
  AiGatewayRouteDeps,
  "originator" | "readModelOverride" | "readAuth" | "readCursorToken" | "readXaiToken"
> & Partial<Pick<AiGatewayRouteDeps, "readAuth" | "readCursorToken" | "readXaiToken">> & {
  /**
   * Whether a newly launched panel gets its own router. Absent means it never does, so a host
   * that does not wire the setting keeps the single Console-wide gateway it has always had.
   */
  readonly dedicatedGatewayPerPanel?: () => boolean;
};

export function registerAiGatewayRoutes(
  ctx: FleetPluginServerContext,
  deps: ConsoleAiGatewayRouteDeps = {},
): DedicatedGatewayPool {
  const ownedDiagnostics = deps.cursorDiagnostics
    ? undefined
    : createCursorDiagnosticLog(path.join(
        ctx.host.paths.pluginDataDir(ctx.pluginId),
        "ai-gateway",
      ));
  // Always on, unlike the wire log: a failed turn is the one event that otherwise leaves no
  // trace, and a post-commit failure reaches the user as a single SSE frame nobody can retrieve.
  const ownedFailureJournal = deps.failureJournal
    ? undefined
    : createFailureJournal({
        filePath: path.join(
          ctx.host.paths.pluginDataDir(ctx.pluginId),
          "ai-gateway",
          "failures.jsonl",
        ),
      });
  // 한 라우터를 여러 번 짓는 유일한 이유는 패널 전용이다. 그 외의 모든 의존은 여기서 한 번
  // 정해지고, 진단 로그·실패 저널 같은 호스트 소유 싱크는 라우터 수와 무관하게 하나로 남는다.
  const buildRouter = (): AiGatewayRouter => createAiGatewayRouter({
    ...deps,
    originator: "fleet-console",
    failureJournal: deps.failureJournal ?? ownedFailureJournal?.write,
    // 자격증명 조달은 호스트 결정이다 — Console은 core-ai-gateway가 export한 기본 reader를 주입한다.
    readAuth: deps.readAuth ?? (() => readCodexSubscriptionAuth()),
    readCursorToken: deps.readCursorToken ?? (() => readCursorSubscriptionToken()),
    readXaiToken: deps.readXaiToken ?? (() => readXaiSubscriptionToken()),
    readModelOverride: () => process.env[AI_GATEWAY_MODEL_ENV],
    cursorDiagnostics: deps.cursorDiagnostics ?? ownedDiagnostics?.write,
  });
  const shared = buildRouter();
  const readDedicated = deps.dedicatedGatewayPerPanel;
  const pool = createDedicatedGatewayPool({
    enabled: readDedicated ?? (() => false),
    createRouter: buildRouter,
  });
  ctx.host.lifecycle.registerCleanup(async () => {
    pool.dispose();
    shared.dispose();
    await ownedDiagnostics?.flush();
    await ownedFailureJournal?.flush();
  });
  registerRouter(ctx, AI_GATEWAY_ROUTE_SEGMENT, (routeCtx) => {
    // A request naming no live panel is served by the shared router rather than refused: after a
    // Console restart a surviving child still sends the panel id it was launched with, and
    // failing it here would kill a turn for a reason the caller can neither see nor retry.
    return (pool.resolve(routeCtx.req.headers) ?? shared).handle(routeCtx);
  }, [
    { method: "*", path: "/api/hello", summary: "Read the AI Gateway health response.", category: "Terminal Plugin", gate: "loopback", transport: "http" },
    { method: "*", path: "/v1/models", summary: "Proxy the AI Gateway model listing.", category: "Terminal Plugin", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/messages", summary: "Proxy an Anthropic Messages request through the AI Gateway.", category: "Terminal Plugin", gate: "anthropic-credential", transport: "proxy" },
  ]);
  return pool;
}
