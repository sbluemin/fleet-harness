import { EventEmitter } from "node:events";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
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
});

describe("session controls", () => {
  it("passes the chosen model, effort and locale to the session and rejects an unsafe model id", async () => {
    // 모델 id는 `--model`에 그대로 들어간다 — 모양이 어긋난 값은 자식에게 닿기 전에 거절한다.
    const created: unknown[] = [];
    const harness = createHarness(true, { admiral: "tori", model: "haiku", effort: "high", locale: "ko" });
    let consoleUse = true;
    Object.assign(harness.ctx.host, { experiments: { read: () => ({ ...DEFAULT_EXPERIMENT_SETTINGS, consoleControl: consoleUse }) } });
    registerChatRoutes(harness.ctx, {
      createSession: (options) => {
        created.push(options);
        return new FakeSession();
      },
      id: () => "chat-a",
    });
    await harness.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    expect(harness.writeJson.mock.calls.at(-1)?.[1]).toBe(200);
    expect(created[0]).toMatchObject({ admiral: "tori", model: "haiku", effort: "high", locale: "ko" });
    expect(created[0]).toHaveProperty("agent", harness.ctx.host.agent);
    const injected = (created[0] as { consoleRead: { consoleRead: { enabled: () => boolean; tools: string[] } } }).consoleRead.consoleRead;
    expect(injected.tools).toEqual(["console_theaters", "console_operations"]);
    expect(injected.enabled()).toBe(true);
    consoleUse = false;
    expect(injected.enabled()).toBe(false);

    const unsafe = createHarness(true, { admiral: "tori", model: "sonnet --dangerously-skip" });
    registerChatRoutes(unsafe.ctx, { createSession: () => new FakeSession() });
    await unsafe.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    expect(unsafe.writeJson.mock.calls.at(-1)?.[1]).toBe(400);
  });

  it("cancels only the active turn and keeps the session for the next question", async () => {
    const harness = createHarness(true, {});
    const session = new FakeSession();
    const registry = registerChatRoutes(harness.ctx);
    await registry.start("chat", (onEvent) => {
      session.onEvent = onEvent;
      return session;
    });
    expect(await registry.message("chat", "first")).toBe("accepted");
    await harness.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/chat/cancel",
    });
    expect(session.cancelled).toBe(1);
    expect(harness.writeJson.mock.calls.at(-1)?.[2]).toEqual({ cancelled: true });
    session.onEvent?.({ type: "cancelled" });
    expect(registry.status("chat")).toBe("idle");
    expect(await registry.message("chat", "second")).toBe("accepted");
    await registry.dispose();
  });
});

describe("Agent SDK availability", () => {
  it("reports an unavailable Console Agent without exposing host details", async () => {
    // 포트를 추측해 띄우면 자식이 첫 턴에서야 알 수 없는 이유로 죽는다.
    const harness = createHarness(true, { admiral: "tori" }, null);
    registerChatRoutes(harness.ctx, {
      id: () => "browser-chat-id",
    });
    await harness.handler()({
      req: request("POST", { "content-type": "application/json" }) as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/start",
    });
    expect(harness.writeJson.mock.calls.at(-1)?.[1]).toBe(503);
    expect(harness.writeJson.mock.calls.at(-1)?.[2]).toEqual({ error: "session_unavailable" });
  });
});

function createHarness(authorized: boolean, body: unknown = {}, origin: string | null = "http://127.0.0.1:43210"): {
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
      agent: { createSession: async () => { throw new Error("agent_gateway_unavailable"); } },
      security: { isTerminalAuthorized: () => authorized },
      http: { writeJson, readJsonBody: async () => body },
      paths: { pluginDataDir: () => "/private/fleet/plugins/scuttlebutt" },
      server: { origin: () => origin },
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
  cancelled = 0;
  async start(): Promise<void> {}
  send(): Promise<void> {
    return new Promise(() => undefined);
  }
  cancel(): void {
    this.cancelled += 1;
  }
  async dispose(): Promise<void> {}
}

class FailingSession extends FakeSession {
  override async start(): Promise<void> {
    throw new Error("CLI unavailable");
  }
}
