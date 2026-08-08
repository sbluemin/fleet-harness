import http from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import type { UpgradeHandler } from "@fleet-console/sdk/routing";

import { resolveConsolePackageRequire } from "./console-require.js";
import type { TerminalSessionManager, TerminalTicketContext } from "./terminal-types.js";

export interface TerminalUpgradeHandlerDeps {
  readonly tickets: {
    consume(ticket: string | null): TerminalTicketContext | null;
  };
  readonly sessions: TerminalSessionManager;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
}

export interface TerminalUpgradeHandler {
  readonly handleUpgrade: UpgradeHandler;
  close(): void;
}

// esbuild가 이 모듈을 node_modules 밖으로 번들해도 ws가 해석되도록, @dotobokuri/fleet-console
// 패키지 기준의 require로 앵커링한다(자세한 배경은 console-require.ts 참고).
const require = resolveConsolePackageRequire(fileURLToPath(import.meta.url), createRequire(import.meta.url));

export function createPluginTerminalUpgradeHandler(deps: TerminalUpgradeHandlerDeps): TerminalUpgradeHandler {
  let wsServer: WebSocketServerLike | null = null;

  const handleUpgrade: UpgradeHandler = ({ req, socket, head }) => {
    const url = readUpgradeUrl(req);
    if (!deps.isAuthorized(req)) {
      socket.destroy();
      return true;
    }
    const context = deps.tickets.consume(url.searchParams.get("ticket"));
    if (!context || !deps.sessions.canAttach(context.sessionId)) {
      socket.destroy();
      return true;
    }
    const server = getWebSocketServer();
    if (context.role === "viewer") {
      // 관전은 살아 있는 세션에만 붙는다. 없으면 열자마자 닫아 클라이언트가 이유를 읽게 한다 —
      // 소켓을 destroy하면 브라우저에는 원인 없는 연결 실패로만 보인다.
      server.handleUpgrade(req, socket, head, (ws) => {
        if (!deps.sessions.attachViewer(ws, context.sessionId)) ws.close(1013, "terminal_unavailable");
      });
      return true;
    }
    server.handleUpgrade(req, socket, head, (ws) => {
      deps.sessions.attach(ws, context).catch((err: unknown) => {
        console.error("[terminal] attach failed", err);
        ws.close(1013, "terminal_unavailable");
      });
    });
    return true;
  };

  function close(): void {
    wsServer?.close();
    wsServer = null;
  }

  return { handleUpgrade, close };

  function getWebSocketServer(): WebSocketServerLike {
    if (wsServer) return wsServer;
    const { WebSocketServer } = require("ws") as {
      readonly WebSocketServer: new (options: { readonly noServer: true }) => WebSocketServerLike;
    };
    wsServer = new WebSocketServer({ noServer: true });
    return wsServer;
  }
}

interface WebSocketServerLike {
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: Parameters<TerminalSessionManager["attach"]>[0]) => void): void;
  close(): void;
}

function readUpgradeUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}
