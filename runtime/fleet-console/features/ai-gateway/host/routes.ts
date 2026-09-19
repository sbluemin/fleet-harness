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
  createClaudeCodexCompactionStore,
  readAntigravitySubscriptionToken,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
  readXaiSubscriptionToken,
} from "@fleet-console/ai-gateway";
import type { AiGatewayRouteDeps } from "@fleet-console/ai-gateway";

export { AI_GATEWAY_ROUTE_SEGMENT } from "@fleet-console/ai-gateway";

export type ConsoleAiGatewayRouteDeps = Omit<
  AiGatewayRouteDeps,
  "originator" | "readModelOverride" | "readAuth" | "readCursorToken" | "readXaiToken" | "readAntigravityToken" | "renewAntigravityToken"
> & Partial<Pick<AiGatewayRouteDeps, "readAuth" | "readCursorToken" | "readXaiToken" | "readAntigravityToken" | "renewAntigravityToken">>;

export function registerAiGatewayRoutes(
  ctx: GatewayHostContext,
  deps: ConsoleAiGatewayRouteDeps = {},
): { readonly compactHookToken: string } {
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
  const compactHookToken = randomUUID();
  const compactionStore = createClaudeCodexCompactionStore({
    directory: path.join(ctx.dataDir, "ai-gateway"),
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
  ctx.registerRouter(AI_GATEWAY_ROUTE_SEGMENT, router.handle, [
    { method: "*", path: "/api/hello", summary: "Read the AI Gateway health response.", category: "Console Execution", gate: "loopback", transport: "http" },
    { method: "*", path: "/v1/models", summary: "Proxy the AI Gateway model listing.", category: "Console Execution", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/messages", summary: "Proxy an Anthropic Messages request through the AI Gateway.", category: "Console Execution", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/compact-events", summary: "Receive a Claude compact lifecycle event.", category: "Console Execution", gate: "lock-token", transport: "http" },
  ]);
  return { compactHookToken };
}
