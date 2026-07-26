import { EventEmitter } from "node:events";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { describe, expect, it, vi } from "vitest";

import { registerChatRoutes } from "../server/chat-routes.js";
import type { ChatEvent, ChatSessionLike } from "../server/chat-session.js";

describe("chat routes", () => {
  it("returns 403 before every handler when terminal authorization fails", async () => {
    const harness = createHarness(false);
    registerChatRoutes(harness.ctx);
    await harness.handler()({
      req: request("POST") as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    expect(harness.writeJson).toHaveBeenCalledWith(expect.anything(), 403, { error: "forbidden" });
  });

  it("streams only browser-safe chat events without provider session identity", async () => {
    const harness = createHarness(true);
    const session = new FakeSession();
    const registry = registerChatRoutes(harness.ctx);
    await registry.start("chat", (onEvent) => {
      session.onEvent = onEvent;
      return session;
    });
    const req = request("GET");
    const res = response();
    await harness.handler()({
      req: req as never,
      res: res as never,
      pathname: "/plugins/scuttlebutt/chat/chat/stream",
    });
    session.onEvent?.({ type: "chunk", text: "safe answer" });
    const payload = res.writes.join("");
    expect(payload).toContain("safe answer");
    expect(payload).not.toContain("providerSession");
    expect(payload).not.toContain("sessionId");
    expect(payload).not.toContain("/private/");
    req.emit("close");
    await registry.dispose();
  });

  it("starts an ephemeral chat without leaking provider identity or absolute paths", async () => {
    const harness = createHarness(true, { admiral: "bori" });
    const createSession = vi.fn(() => new FakeSession());
    const ensureDir = vi.fn(async () => undefined);
    registerChatRoutes(harness.ctx, {
      createSession,
      ensureDir,
      id: () => "browser-chat-id",
    });
    await harness.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    const payload = harness.writeJson.mock.calls.at(-1)?.[2];
    expect(payload).toEqual({ chatId: "browser-chat-id" });
    expect(JSON.stringify(payload)).not.toContain("sessionId");
    expect(JSON.stringify(payload)).not.toContain("/private/");
    expect(createSession).toHaveBeenCalledWith({
      cwd: "/private/fleet/plugins/scuttlebutt/workspace/bori",
      admiral: "bori",
      onEvent: expect.any(Function),
    });
    // 제독별 작업 디렉터리는 먼저 만들어져야 한다 — 없는 경로에서는 CLI 기동이 실패한다.
    expect(ensureDir).toHaveBeenCalledWith("/private/fleet/plugins/scuttlebutt/workspace/bori");
  });

  it("refuses to start when the admiral workspace cannot be created", async () => {
    const harness = createHarness(true, { admiral: "dori" });
    const createSession = vi.fn(() => new FakeSession());
    registerChatRoutes(harness.ctx, {
      createSession,
      ensureDir: async () => {
        throw new Error("EACCES");
      },
    });
    await harness.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    expect(harness.writeJson).toHaveBeenCalledWith(expect.anything(), 503, { error: "session_unavailable" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { admiral: "zzz" },
    { admiral: "tori", extra: 1 },
  ])("rejects browser selection fields in the start body: %o", async (body) => {
    const harness = createHarness(true, body);
    registerChatRoutes(harness.ctx);
    await harness.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    expect(harness.writeJson).toHaveBeenCalledWith(expect.anything(), 400, { error: "invalid_start" });
  });

  it("removes the empty chat catalog route", async () => {
    const harness = createHarness(true);
    registerChatRoutes(harness.ctx);
    expect(await harness.handler()({
      req: request("GET") as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/catalog",
    })).toBe(false);
  });

  it("returns a visible start failure when the fixed CLI cannot open", async () => {
    const harness = createHarness(true, { admiral: "tori" });
    registerChatRoutes(harness.ctx, {
      createSession: () => new FailingSession(),
    });
    await harness.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    expect(harness.writeJson).toHaveBeenCalledWith(expect.anything(), 503, { error: "session_unavailable" });
  });
});

function createHarness(authorized: boolean, body: unknown = {}): {
  readonly ctx: FleetPluginServerContext;
  readonly handler: () => RouteHandler;
  readonly writeJson: ReturnType<typeof vi.fn>;
} {
  let routeHandler: RouteHandler | undefined;
  const writeJson = vi.fn();
  const ctx = {
    pluginId: "scuttlebutt",
    manifest: { id: "scuttlebutt" },
    basePath: "/plugins/scuttlebutt",
    wsBasePath: "/plugins/scuttlebutt/ws",
    registerRouter: (_path: string, handler: RouteHandler) => {
      routeHandler = handler;
    },
    registerWsHandler: vi.fn(),
    host: {
      security: { isTerminalAuthorized: () => authorized },
      http: { writeJson, readJsonBody: async () => body },
      paths: { pluginDataDir: () => "/private/fleet/plugins/scuttlebutt" },
      lifecycle: { registerCleanup: vi.fn(() => () => undefined) },
    },
  } as unknown as FleetPluginServerContext;
  return {
    ctx,
    handler: () => {
      if (!routeHandler) throw new Error("route not registered");
      return routeHandler;
    },
    writeJson,
  };
}

function request(
  method: string,
  headers: Record<string, string> = {},
): EventEmitter & { method: string; headers: Record<string, string> } {
  return Object.assign(new EventEmitter(), { method, headers });
}

function response(): {
  writableEnded: boolean;
  destroyed: boolean;
  writes: string[];
  writeHead: ReturnType<typeof vi.fn>;
  write(data: string): void;
  end(): void;
} {
  return {
    writableEnded: false,
    destroyed: false,
    writes: [],
    writeHead: vi.fn(),
    write(data) {
      this.writes.push(data);
    },
    end() {
      this.writableEnded = true;
    },
  };
}

class FakeSession implements ChatSessionLike {
  onEvent?: (event: ChatEvent) => void;
  async start(): Promise<void> {}
  async send(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class FailingSession extends FakeSession {
  override async start(): Promise<void> {
    throw new Error("CLI unavailable");
  }
}
