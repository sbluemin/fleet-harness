import http from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";

import type { UpgradeHandler } from "@fleet-console/sdk/routing";

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

const require = createRequire(import.meta.url);

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
