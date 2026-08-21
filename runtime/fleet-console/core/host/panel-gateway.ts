import http from "node:http";
import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  AI_GATEWAY_ROUTE_SEGMENT,
  createAiGatewayRouter,
  createAiGatewaySettingsStore,
  createCursorDiagnosticLog,
  createFailureJournal,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
  readXaiSubscriptionToken,
} from "@dotobokuri/core-ai-gateway";
import { KIMI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID } from "@dotobokuri/fleet-admiral";
import { createInfraServices, getFleetDataDir } from "@dotobokuri/core-infra";

/**
 * Route path a panel gateway mounts at.
 *
 * Kept identical to the Console-hosted gateway's last segment so a child's `ANTHROPIC_BASE_URL`
 * differs from the shared one only in its port. Nothing depends on that beyond readability — the
 * router matches its endpoints by suffix — but a log line or a `/status` screen showing two URLs
 * that differ in one number is far easier to reason about than two unrelated shapes.
 */
export const PANEL_GATEWAY_ROUTE_PATH = `/${AI_GATEWAY_ROUTE_SEGMENT}`;

/**
 * Line the child writes to stdout once it is listening, followed by the **full base URL** a client
 * must dial — mount path included.
 *
 * The child reports the whole URL rather than just its port because it is the only side that knows
 * where it mounted. Handing back a port made the parent reconstruct the rest, and reconstructing it
 * is exactly what went wrong: the mount was dropped and every model request through a dedicated
 * gateway 404'd, while tests that appended the mount themselves stayed green.
 */
export const PANEL_GATEWAY_READY_PREFIX = "fleet-panel-gateway-ready ";

/**
 * Runs one panel's AI gateway as its own process.
 *
 * A process rather than another router inside the Console is the whole point of this file. Node's
 * `fetch` keeps one global undici dispatcher per process — measured 2026-08-22, the first fetch
 * installs `Symbol(undici.globalDispatcher.1)` on `globalThis` — so routers sharing a process also
 * share every upstream connection pool, and provider adapters that keep module-scoped state share
 * that too. Only a process boundary separates them, and it separates the crash domain with them.
 *
 * Settings and credentials are deliberately *not* separated: the child reads the same
 * `ai-gateway.json` and the same auth store the Console does, because a panel is meant to get its
 * own connections, not its own configuration.
 */
export async function runPanelGateway(): Promise<void> {
  const dataDir = getFleetDataDir();
  const infraServices = createInfraServices();
  const store = createAiGatewaySettingsStore({ dataDir });
  const logDir = path.join(dataDir, "console", "plugins", "terminal", "ai-gateway");
  /**
   * 진단 파일은 이 프로세스 전용이다.
   *
   * 처음에는 Console과 같은 파일을 쓰게 두었다 — "이 기기의 실패 기록"이 하나여야 한 번에 보이니까.
   * 그런데 두 구현 모두 회전을 **프로세스 안에서만** 직렬화한다(저널은 로컬 promise 체인, Cursor
   * 진단 로그는 로컬 바이트 카운터). 게이트웨이 여러 개가 같은 파일을 2 MiB 근처에서 함께 밀면
   * 한쪽의 rename이 다른 쪽이 방금 만든 파일을 백업으로 덮어써, 지키려던 그 기록을 잃는다.
   *
   * 그래서 조회는 한 파일이 아니라 한 디렉터리가 된다 — `failures*.jsonl`을 모아 읽으면 된다.
   * Console 자신의 파일 이름은 그대로라 기존 조회 습관도 깨지지 않는다.
   */
  const suffix = `panel-${process.pid}`;
  const diagnostics = createCursorDiagnosticLog(logDir, { fileName: `cursor-${suffix}.jsonl` });
  const failureJournal = createFailureJournal({ filePath: path.join(logDir, `failures.${suffix}.jsonl`) });
  const router = createAiGatewayRouter({
    failureJournal: failureJournal.write,
    readAiGatewaySettings: () => store.read(),
    readKimiApiKey: () => infraServices.authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
    readOpencodeApiKey: () => infraServices.authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
    originator: "fleet-console",
    readAuth: () => readCodexSubscriptionAuth(),
    readCursorToken: () => readCursorSubscriptionToken(),
    readXaiToken: () => readXaiSubscriptionToken(),
    readModelOverride: () => process.env[AI_GATEWAY_MODEL_ENV],
    cursorDiagnostics: diagnostics.write,
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const mounted = pathname === PANEL_GATEWAY_ROUTE_PATH
          || pathname.startsWith(`${PANEL_GATEWAY_ROUTE_PATH}/`);
        if (mounted && await router.handle({ req, res, pathname })) return;
        writeNotFound(res);
      } catch {
        if (!res.headersSent) writeNotFound(res);
        else if (!res.writableEnded) res.end();
      }
    })();
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    router.dispose();
    await diagnostics.flush();
    await failureJournal.flush();
    process.exit(0);
  };

  try {
    await listen(server);
  } catch (error) {
    router.dispose();
    await diagnostics.flush();
    await failureJournal.flush();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("panel_gateway_not_listening");
  process.stdout.write(`${PANEL_GATEWAY_READY_PREFIX}http://127.0.0.1:${address.port}${PANEL_GATEWAY_ROUTE_PATH}\n`);

  /**
   * 부모가 사라지면 이 프로세스도 사라져야 한다. stdin은 부모가 쥔 파이프이므로, 부모가 죽으면
   * 이쪽에서 EOF로 그것을 안다 — Console이 크래시해도 게이트웨이 자식이 포트를 쥔 채 남지 않는다.
   */
  process.stdin.on("end", () => { void shutdown(); });
  process.stdin.on("close", () => { void shutdown(); });
  process.stdin.resume();
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":"not_found"}');
}
