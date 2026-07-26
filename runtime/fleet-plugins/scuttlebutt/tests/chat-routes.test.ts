import { EventEmitter } from "node:events";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { describe, expect, it, vi } from "vitest";

import { buildChatCatalog, registerChatRoutes } from "../server/chat-routes.js";
import type { ChatEvent, ChatSessionLike } from "../server/chat-session.js";

describe("chat routes", () => {
  it("returns 403 before every handler when terminal authorization fails", async () => {
    const harness = createHarness(false);
    registerChatRoutes(harness.ctx, { detect: async () => [] });
    await harness.handler()({
      req: request("GET") as never,
      res: response() as never,
      pathname: "/plugins/scuttlebutt/chat/catalog",
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
    req.emit("close");
    await registry.dispose();
  });

  it("catalog includes only the frozen CLI set and detector defaults", () => {
    const catalog = buildChatCatalog([
      { cli: "claude", path: "claude", available: true, protocols: ["acp"] },
      { cli: "claude-kimi", path: "claude", available: true, protocols: ["acp"] },
      { cli: "codex", path: "codex", available: true, protocols: ["codex-app-server"] },
      { cli: "cursor", path: "cursor-agent", available: true, protocols: ["acp"] },
    ], []);
    expect(catalog.clis.map((cli) => cli.cliId)).toEqual(["claude", "claude-kimi", "codex"]);
    expect(catalog.clis[2]).toMatchObject({
      cliId: "codex",
      available: false,
      reason: "web_only_policy_unsupported",
    });
    expect(catalog.settings).toEqual({
      enabled: true,
      cliId: "claude",
      model: catalog.clis[0]?.defaultModel,
      effort: null,
    });
  });
});

function createHarness(authorized: boolean): {
  readonly ctx: FleetPluginServerContext;
  readonly handler: () => RouteHandler;
  readonly writeJson: ReturnType<typeof vi.fn>;
} {
  let routeHandler: RouteHandler | undefined;
  const writeJson = vi.fn();
  const storageValue = new Map<string, unknown>();
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
      http: { writeJson, readJsonBody: async () => ({}) },
      storage: {
        readJson: async (_pluginId: string, key: string) => storageValue.get(key),
        writeJson: async (_pluginId: string, key: string, value: unknown) => {
          storageValue.set(key, value);
        },
      },
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

function request(method: string): EventEmitter & { method: string; headers: Record<string, string> } {
  return Object.assign(new EventEmitter(), { method, headers: {} });
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
