import http from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";

import type { TerminalSessionManager, TerminalTicketContext } from "./types.js";

export interface TerminalUpgradeHandlerDeps {
  readonly expectedHost: string;
  readonly getExpectedPort: () => number;
  readonly tickets: {
    consume(ticket: string | null): TerminalTicketContext | null;
  };
  readonly sessions: TerminalSessionManager;
  readonly validateHost: (req: http.IncomingMessage, expectedPort: number) => boolean;
}

export interface TerminalUpgradeHandler {
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

export const TERMINAL_TICKET_PATH = "/terminal/ticket";
export const TERMINAL_WS_PATH = "/terminal/ws";
const require = createRequire(import.meta.url);

export function createTerminalUpgradeHandler(deps: TerminalUpgradeHandlerDeps): TerminalUpgradeHandler {
  let wsServer: WebSocketServerLike | null = null;

  function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = readUpgradeUrl(req);
    if (url.pathname !== TERMINAL_WS_PATH) return false;
    const expectedPort = deps.getExpectedPort();
    if (!deps.validateHost(req, expectedPort) || !validateOrigin(req, deps.expectedHost, expectedPort)) {
      socket.destroy();
      return true;
    }
    const context = deps.tickets.consume(url.searchParams.get("ticket"));
    if (!context || !deps.sessions.canAttach()) {
      socket.destroy();
      return true;
    }
    const server = getWebSocketServer();
    server.handleUpgrade(req, socket, head, (ws) => {
      try {
        deps.sessions.attach(ws, context);
      } catch {
        ws.close(1013, "terminal_unavailable");
      }
    });
    return true;
  }

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

function validateOrigin(req: http.IncomingMessage, expectedHost: string, expectedPort: number): boolean {
  return req.headers.origin === `http://${expectedHost}:${expectedPort}`;
}
