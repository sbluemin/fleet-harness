import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
  createAiGatewayRouter,
  createCursorDiagnosticLog,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
} from "@dotobokuri/core-ai-gateway";
import type { AiGatewayRouteDeps } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

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
} from "@dotobokuri/core-ai-gateway";
export type {
  AiGatewayRouteDeps,
  AiGatewayRouter,
  CodexSubscriptionAuth,
} from "@dotobokuri/core-ai-gateway";

export type ConsoleAiGatewayRouteDeps = Omit<
  AiGatewayRouteDeps,
  "originator" | "readModelOverride" | "readAuth" | "readCursorToken"
> & Partial<Pick<AiGatewayRouteDeps, "readAuth" | "readCursorToken">>;

export function registerAiGatewayRoutes(
  ctx: FleetPluginServerContext,
  deps: ConsoleAiGatewayRouteDeps = {},
): void {
  const ownedDiagnostics = deps.cursorDiagnostics
    ? undefined
    : createCursorDiagnosticLog(path.join(
        ctx.host.paths.pluginDataDir(ctx.pluginId),
        "ai-gateway",
      ));
  const router = createAiGatewayRouter({
    ...deps,
    originator: "fleet-console",
    // 자격증명 조달은 호스트 결정이다 — Console은 core-ai-gateway가 export한 기본 reader를 주입한다.
    readAuth: deps.readAuth ?? (() => readCodexSubscriptionAuth()),
    readCursorToken: deps.readCursorToken ?? (() => readCursorSubscriptionToken()),
    readModelOverride: () => process.env[AI_GATEWAY_MODEL_ENV],
    cursorDiagnostics: deps.cursorDiagnostics ?? ownedDiagnostics?.write,
  });
  ctx.host.lifecycle.registerCleanup(() => {
    router.dispose();
    return ownedDiagnostics?.flush();
  });
  registerRouter(ctx, AI_GATEWAY_ROUTE_SEGMENT, [
    { method: "*", path: "/api/hello", summary: "Read the AI Gateway health response.", category: "Terminal Plugin", gate: "loopback", transport: "http" },
    { method: "*", path: "/v1/models", summary: "Proxy the AI Gateway model listing.", category: "Terminal Plugin", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/messages", summary: "Proxy an Anthropic Messages request through the AI Gateway.", category: "Terminal Plugin", gate: "anthropic-credential", transport: "proxy" },
  ], router.handle);
}
