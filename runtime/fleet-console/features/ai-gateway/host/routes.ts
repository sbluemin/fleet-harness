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
import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
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
> & Partial<Pick<AiGatewayRouteDeps, "readAuth" | "readXaiToken" | "readMuseCodeAuth" | "resolveExecutionModel">>;

/** 압축 사건 하나. 외부 훅 대신 인프로세스 콜백이 이 모양으로 넘긴다. */
export interface ConsoleCompactEvent {
  readonly phase: "pre" | "post";
  readonly sessionId: string;
  readonly trigger?: string;
  readonly customInstructions?: string;
  readonly summary?: string;
}

export function registerAiGatewayRoutes(
  ctx: GatewayHostContext,
  deps: ConsoleAiGatewayRouteDeps = {},
): {
  /** 압축 사건 하나를 그 세션의 저장소에 기록한다. 인프로세스 훅이 부르는 자리다. */
  readonly recordCompactEvent: (event: ConsoleCompactEvent) => void;
} {
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
  const compactionStore = createClaudeCodexCompactionStore({
    directory: path.join(ctx.dataDir, "ai-gateway"),
  });
  const router = createAiGatewayRouter({
    ...deps,
    originator: "fleet-console",
    compactionStore,
    // 호출 시점의 노출을 읽는다 — 스냅숏이 아니라 지금 켜져 있는 모델이 답이 된다.
    ...(deps.resolveExecutionModel === undefined ? {} : { resolveExecutionModel: deps.resolveExecutionModel }),
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
    { method: "*", path: "/api/hello", summary: "Read the Model Gateway health response.", category: "Console Execution", gate: "loopback", transport: "http" },
    { method: "*", path: "/v1/models", summary: "Proxy the Model Gateway model listing.", category: "Console Execution", gate: "anthropic-credential", transport: "proxy" },
    { method: "POST", path: "/v1/messages", summary: "Proxy an Anthropic Messages request through the Model Gateway.", category: "Console Execution", gate: "anthropic-credential", transport: "proxy" },
  ]);
  return {
    recordCompactEvent: (event) => {
      if (event.phase === "pre") {
        compactionStore.recordPreCompact({
          sessionId: event.sessionId,
          trigger: event.trigger === "manual" ? "manual" : "auto",
          customInstructions: event.customInstructions ?? "",
        });
      } else {
        compactionStore.recordPostCompact({ sessionId: event.sessionId, summary: event.summary ?? "" });
      }
    },
  };
}
