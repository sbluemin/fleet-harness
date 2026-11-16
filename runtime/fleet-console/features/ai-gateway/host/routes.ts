import type { CleanupPort } from "@fleet-console/infra/http/host-ports";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { RouteHandler } from "@fleet-console/infra/http/routing";

interface GatewayHostContext {
  readonly host: {
    readonly lifecycle: Pick<CleanupPort, "registerCleanup">;
  };
  readonly dataDir: string;
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
  createAgyAcpSessionPort,
  createAiGatewayRouter,
  createFailureJournal,
  createRequestTimingJournal,
  createClaudeCodexCompactionStore,
} from "@fleet-console/ai-gateway";
import type { AiGatewayRouteDeps } from "@fleet-console/ai-gateway";

export { AI_GATEWAY_ROUTE_SEGMENT } from "@fleet-console/ai-gateway";

export type ConsoleAiGatewayRouteDeps = Omit<
  AiGatewayRouteDeps,
  "originator" | "readModelOverride" | "readAuth" | "readXaiToken" | "readMuseCodeAuth"
> & Partial<Pick<AiGatewayRouteDeps, "readAuth" | "readXaiToken" | "readMuseCodeAuth" | "assignRouting">>;

/** agy 세션 전용 gemini-dir들의 부모. 세션을 닫으면 지우지만, 프로세스가 죽으면 남으므로 시작할 때 오래된 것을 쓴다. */
const AGY_SESSIONS_STALE_MS = 24 * 60 * 60 * 1000;

function sweepStaleAgySessions(sessionsDir: string): void {
  try {
    for (const entry of readdirSync(sessionsDir)) {
      const target = path.join(sessionsDir, entry);
      if (Date.now() - statSync(target).mtimeMs > AGY_SESSIONS_STALE_MS) rmSync(target, { recursive: true, force: true });
    }
  } catch {
    // No directory yet, or one a concurrent Console is removing: nothing to sweep.
  }
}

export function registerAiGatewayRoutes(
  ctx: GatewayHostContext,
  deps: ConsoleAiGatewayRouteDeps = {},
): { readonly compactHookToken: string; readonly modHookToken: string; readonly releaseAgy: () => void | Promise<void> } {
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
  // agy 세션은 resume하지 않는다: Console이 다시 뜨면 레지스트리가 비어 모든 Antigravity 요청이 새 세션으로 시작한다.
  const agySessionsDir = path.join(ctx.dataDir, "ai-gateway", "agy-sessions");
  sweepStaleAgySessions(agySessionsDir);
  const router = createAiGatewayRouter({
    ...deps,
    agyAcpPort: deps.agyAcpPort ?? createAgyAcpSessionPort({ sessionsDir: agySessionsDir }),
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
    readXaiToken: deps.readXaiToken ?? (() => null),
    readModelOverride: () => process.env[AI_GATEWAY_MODEL_ENV],
  });
  ctx.host.lifecycle.registerCleanup(async () => {
    await router.dispose();
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
  return { compactHookToken, modHookToken, releaseAgy: () => router.releaseAgy() };
}
