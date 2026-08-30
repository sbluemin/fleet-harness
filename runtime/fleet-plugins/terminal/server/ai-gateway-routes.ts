import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
  createAiGatewayRouter,
  createCursorDiagnosticLog,
  createFailureJournal,
  createClaudeCodexCompactionStore,
  readAntigravitySubscriptionToken,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
  readXaiSubscriptionToken,
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
  readAntigravitySubscriptionToken,
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
  "originator" | "readModelOverride" | "readAuth" | "readCursorToken" | "readXaiToken" | "readAntigravityToken" | "renewAntigravityToken"
> & Partial<Pick<AiGatewayRouteDeps, "readAuth" | "readCursorToken" | "readXaiToken" | "readAntigravityToken" | "renewAntigravityToken">>;

export function registerAiGatewayRoutes(
  ctx: FleetPluginServerContext,
  deps: ConsoleAiGatewayRouteDeps = {},
): { readonly compactHookToken: string } {
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
  const compactHookToken = randomUUID();
  const compactionStore = createClaudeCodexCompactionStore({
    directory: path.join(ctx.host.paths.pluginDataDir(ctx.pluginId), "ai-gateway"),
  });
  const router = createAiGatewayRouter({
    ...deps,
    originator: "fleet-console",
    compactionStore,
    compactionHookToken: compactHookToken,
    failureJournal: deps.failureJournal ?? ownedFailureJournal?.write,
    // 자격증명 조달은 호스트 결정이다 — Console은 core-ai-gateway가 export한 기본 reader를 주입한다.
    readAuth: deps.readAuth ?? (() => readCodexSubscriptionAuth()),
    readCursorToken: deps.readCursorToken ?? (() => readCursorSubscriptionToken()),
    readXaiToken: deps.readXaiToken ?? (() => readXaiSubscriptionToken()),
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
  });
  registerRouter(ctx, AI_GATEWAY_ROUTE_SEGMENT, router.handle, [
    { method: "*", path: "/api/hello", summary: "Read the AI Gateway health response.", category: "Terminal Plugin", gate: "loopback", transport: "http" },
    { method: "*", path: "/v1/models", summary: "Proxy the AI Gateway model listing.", category: "Terminal Plugin", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/messages", summary: "Proxy an Anthropic Messages request through the AI Gateway.", category: "Terminal Plugin", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/compact-events", summary: "Receive a Claude compact lifecycle event.", category: "Terminal Plugin", gate: "lock-token", transport: "http" },
  ]);
  return { compactHookToken };
}
