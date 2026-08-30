import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";

import {
  AI_GATEWAY_MODEL_ENV,
  createAiGatewayRouter,
  createCursorDiagnosticLog,
  createFailureJournal,
  createClaudeCodexCompactionStore,
  readAntigravitySubscriptionToken,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
  readXaiSubscriptionToken,
  type AiGatewaySettingsStore,
  type AuthService,
} from "@dotobokuri/core-ai-gateway";
import {
  KIMI_AUTH_PROVIDER_ID,
  OPENCODE_AUTH_PROVIDER_ID,
} from "@dotobokuri/fleet-admiral";

export interface FleetCliGatewayServer {
  origin(): string;
  readonly routePath: string;
  readonly compactHookToken?: string;
  close(): Promise<void>;
}

export async function startGatewayHttpServer(deps: {
  readonly store: AiGatewaySettingsStore;
  readonly authService: AuthService;
  /**
   * 들을 포트. 부재는 임시 포트다. 주소는 언제나 127.0.0.1이며 그 선택은 호출자에게 열려
   * 있지 않다 — 이 라우터에는 인증이 없어서, 루프백을 벗어나는 순간 도달 가능한 누구나
   * 사용자의 구독을 쓸 수 있다.
   */
  readonly port?: number;
}): Promise<FleetCliGatewayServer> {
  const gatewayDir = path.join(path.dirname(deps.store.path), "fleet-cli", "ai-gateway");
  const diagnostics = createCursorDiagnosticLog(gatewayDir);
  const failureJournal = createFailureJournal({
    filePath: path.join(gatewayDir, "failures.jsonl"),
  });
  const compactHookToken = randomUUID();
  const router = createAiGatewayRouter({
    compactionStore: createClaudeCodexCompactionStore({ directory: gatewayDir }),
    compactionHookToken: compactHookToken,
    failureJournal: failureJournal.write,
    readAiGatewaySettings: () => deps.store.read(),
    readKimiApiKey: () => deps.authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
    readOpencodeApiKey: () => deps.authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
    originator: "fleet-cli",
    // 자격증명 조달은 호스트 결정이다 — thin 런처도 export된 기본 reader를 명시 주입한다.
    readAuth: () => readCodexSubscriptionAuth(),
    readCursorToken: () => readCursorSubscriptionToken(),
    readXaiToken: () => readXaiSubscriptionToken(),
    readAntigravityToken: () => readAntigravitySubscriptionToken(),
    renewAntigravityToken: () => readAntigravitySubscriptionToken({ forceRenew: true }),
    readModelOverride: () => process.env[AI_GATEWAY_MODEL_ENV],
    cursorDiagnostics: diagnostics.write,
  });
  const routePath = "/ai-gateway";
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const isMountedPath = pathname === routePath || pathname.startsWith(`${routePath}/`);
      if (isMountedPath && await router.handle({ req, res, pathname })) {
        return;
      }
      writeNotFound(res);
    } catch {
      if (!res.headersSent) {
        writeNotFound(res);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };

  try {
    await listen(server, deps.port);
  } catch (error) {
    router.dispose();
    await diagnostics.flush();
    await failureJournal.flush();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    routePath,
    compactHookToken,
    origin() {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Fleet CLI AI gateway server is not listening.");
      }
      return `http://127.0.0.1:${address.port}`;
    },
    close() {
      closePromise ??= closeServer(server).finally(async () => {
        router.dispose();
        await diagnostics.flush();
        await failureJournal.flush();
      });
      return closePromise;
    },
  };
}

function listen(server: http.Server, port?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port ?? 0, "127.0.0.1");
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":"not_found"}');
}
