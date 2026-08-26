import type { IncomingMessage, ServerResponse } from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { QuotaService } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it, vi } from "vitest";

import { handleConnect, handleFold, handleOrder, handleSummary } from "../server/handlers.js";
import type { SettingsSerializer } from "../server/handlers.js";

function createSerializer(): SettingsSerializer {
  let chain = Promise.resolve();
  return <T>(operation: () => Promise<T>) => {
    const result = chain.then(operation, operation);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
}

function harness(
  method: string,
  url = "/plugins/quota/summary",
  body: unknown = null,
  contentType = "application/json",
) {
  const writes: Array<{ status: number; payload: unknown }> = [];
  const writeJson = vi.fn(async () => {});
  const readJson = vi.fn(async (): Promise<Record<string, unknown>> => ({ claudeConnected: true, cursorConnected: false }));
  const ctx = {
    host: {
      security: { isTerminalAuthorized: () => true },
      storage: { readJson, writeJson },
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, payload: unknown) => writes.push({ status, payload }),
      },
    },
  } as unknown as FleetPluginServerContext;
  const req = {
    method,
    url,
    headers: { host: "localhost", "content-type": contentType },
  } as IncomingMessage;
  const service = {
    getSummary: vi.fn(async () => ({
      providers: {
        claude: { status: "ok", windows: [{ id: "session", usedPercent: 1 }], fetchedAt: 10 },
        codex: { status: "signed_out" },
        cursor: { status: "signed_out" },
      },
    })),
  } as unknown as QuotaService;
  return {
    ctx,
    req,
    res: {} as ServerResponse,
    service,
    serializeSettings: createSerializer(),
    writes,
    readJson,
    writeJson,
  };
}

describe("quota route handlers", () => {
  it("accepts only force=1 and emits a credential-free DTO", async () => {
    const test = harness("GET", "/plugins/quota/summary?force=1");
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.service.getSummary).toHaveBeenCalledWith({ force: true });
    const json = JSON.stringify(test.writes[0]?.payload);
    expect(json).not.toMatch(/accessToken|access_token|account_id|Users|\\\\Users/);
  });

  it("updates one connection flag while preserving the other and returns a forced summary", async () => {
    const test = harness("POST", "/plugins/quota/connect", { provider: "claude", connected: true });
    await handleConnect(test.req, test.res, test.ctx, test.service, test.serializeSettings);
    expect(test.writeJson).toHaveBeenCalledWith(
      "quota",
      "settings",
      { claudeConnected: true, cursorConnected: false },
    );
    expect(test.service.getSummary).toHaveBeenCalledWith({ forceProvider: "claude" });
    expect(test.writes[0]?.status).toBe(200);

    const cursor = harness("POST", "/plugins/quota/connect", { provider: "cursor", connected: true });
    await handleConnect(cursor.req, cursor.res, cursor.ctx, cursor.service, cursor.serializeSettings);
    expect(cursor.writeJson).toHaveBeenCalledWith(
      "quota",
      "settings",
      { claudeConnected: true, cursorConnected: true },
    );
    expect(cursor.service.getSummary).toHaveBeenCalledWith({ forceProvider: "cursor" });
  });

  it("serializes concurrent connection flag mutations without losing either update", async () => {
    for (const order of ["claude-first", "cursor-first"] as const) {
      let stored = { claudeConnected: true, cursorConnected: false };
      const writes: unknown[] = [];
      const ctx = {
        host: {
          security: { isTerminalAuthorized: () => true },
          storage: {
            readJson: async () => ({ ...stored }),
            writeJson: async (_plugin: string, _key: string, value: typeof stored) => {
              await Promise.resolve();
              stored = value;
              writes.push(value);
            },
          },
          http: {
            readJsonBody: async (req: IncomingMessage) => (req as IncomingMessage & { body: unknown }).body,
            writeJson: () => {},
          },
        },
      } as unknown as FleetPluginServerContext;
      const service = {
        getSummary: vi.fn(async () => ({
          providers: {
            claude: { status: "signed_out" },
            codex: { status: "signed_out" },
            cursor: { status: "signed_out" },
          },
        })),
      } as unknown as QuotaService;
      const request = (body: unknown) => ({
        method: "POST",
        url: "/plugins/quota/connect",
        headers: { host: "localhost", "content-type": "application/json" },
        body,
      }) as unknown as IncomingMessage;
      const claude = () => handleConnect(
        request({ provider: "claude", connected: false }),
        {} as ServerResponse,
        ctx,
        service,
        serializer,
      );
      const cursor = () => handleConnect(
        request({ provider: "cursor", connected: true }),
        {} as ServerResponse,
        ctx,
        service,
        serializer,
      );
      const serializer = createSerializer();
      const pending = order === "claude-first" ? [claude(), cursor()] : [cursor(), claude()];
      await Promise.all(pending);
      expect(stored, order).toEqual({ claudeConnected: false, cursorConnected: true });
      expect(writes, order).toHaveLength(2);
    }
  });

  it("rejects malformed bodies and wrong methods", async () => {
    const malformed = harness("POST", "/plugins/quota/connect", { provider: "codex", connected: true });
    await handleConnect(
      malformed.req,
      malformed.res,
      malformed.ctx,
      malformed.service,
      malformed.serializeSettings,
    );
    expect(malformed.writes).toEqual([{ status: 400, payload: { error: "invalid_connect_request" } }]);
    expect(malformed.writeJson).not.toHaveBeenCalled();

    const extraKey = harness(
      "POST",
      "/plugins/quota/connect",
      { provider: "cursor", connected: true, extra: false },
    );
    await handleConnect(
      extraKey.req,
      extraKey.res,
      extraKey.ctx,
      extraKey.service,
      extraKey.serializeSettings,
    );
    expect(extraKey.writes).toEqual([{ status: 400, payload: { error: "invalid_connect_request" } }]);

    const wrongMethod = harness("POST");
    await handleSummary(wrongMethod.req, wrongMethod.res, wrongMethod.ctx, wrongMethod.service);
    expect(wrongMethod.writes[0]?.status).toBe(405);
  });

  it("appends the stored provider order to summary responses after sanitizing it", async () => {
    const test = harness("GET", "/plugins/quota/summary");
    test.readJson.mockResolvedValue({ providerOrder: ["opencode", "bogus", "claude", "opencode"] });
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect((test.writes[0]?.payload as { providerOrder: unknown }).providerOrder)
      .toEqual(["opencode", "claude", "codex", "xai", "cursor", "kimi", "antigravity"]);
  });

  it("persists a full provider order while preserving connection flags", async () => {
    const order = ["opencode", "kimi", "cursor", "xai", "codex", "claude", "antigravity"];
    const test = harness("POST", "/plugins/quota/order", { order });
    await handleOrder(test.req, test.res, test.ctx, test.serializeSettings);
    expect(test.writeJson).toHaveBeenCalledWith("quota", "settings", {
      claudeConnected: true,
      cursorConnected: false,
      providerOrder: order,
    });
    expect(test.writes).toEqual([{ status: 200, payload: { providerOrder: order } }]);
  });

  it("accepts the full-deck permutation the panel posts after a drag", async () => {
    // 서버는 현재 기본 집합의 완전한 순열만 받는다. 공급자가 하나 늘어난 뒤 옛 덱을 받으면
    // POST /order가 400으로 거절되고, 패널은 summary로 되돌려 드래그가 적용되지 않은 것처럼 보인다.
    const order = ["kimi", "claude", "codex", "xai", "cursor", "opencode", "antigravity"];
    const test = harness("POST", "/plugins/quota/order", { order });
    await handleOrder(test.req, test.res, test.ctx, test.serializeSettings);
    expect(test.writeJson).toHaveBeenCalledWith("quota", "settings", {
      claudeConnected: true,
      cursorConnected: false,
      providerOrder: order,
    });
    expect(test.writes).toEqual([{ status: 200, payload: { providerOrder: order } }]);
  });

  it("rejects partial, duplicated, unknown, or non-array provider orders", async () => {
    const invalid: unknown[] = [
      ["claude", "codex", "cursor", "kimi", "opencode", "antigravity"],
      ["claude", "codex", "xai", "cursor", "kimi", "opencode"],
      ["claude", "claude", "codex", "xai", "cursor", "kimi", "antigravity"],
      ["claude", "codex", "xai", "cursor", "kimi", "opencode", "bogus"],
      "claude",
    ];
    for (const order of invalid) {
      const test = harness("POST", "/plugins/quota/order", { order });
      await handleOrder(test.req, test.res, test.ctx, test.serializeSettings);
      expect(test.writes, JSON.stringify(order)).toEqual([{ status: 400, payload: { error: "invalid_order_request" } }]);
      expect(test.writeJson, JSON.stringify(order)).not.toHaveBeenCalled();
    }
  });

  it("keeps a stored provider order when a connection flag changes", async () => {
    const test = harness("POST", "/plugins/quota/connect", { provider: "claude", connected: true });
    test.readJson.mockResolvedValue({
      claudeConnected: false,
      providerOrder: ["kimi", "claude", "codex", "xai", "cursor", "opencode", "antigravity"],
    });
    await handleConnect(test.req, test.res, test.ctx, test.service, test.serializeSettings);
    expect(test.writeJson).toHaveBeenCalledWith("quota", "settings", {
      claudeConnected: true,
      providerOrder: ["kimi", "claude", "codex", "xai", "cursor", "opencode", "antigravity"],
    });
  });

  it("appends the stored fold set to summary responses after sanitizing it", async () => {
    const test = harness("GET", "/plugins/quota/summary");
    test.readJson.mockResolvedValue({ foldedProviders: ["kimi", "bogus", "claude", "kimi"] });
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect((test.writes[0]?.payload as { foldedProviders: unknown }).foldedProviders)
      .toEqual(["claude", "kimi"]);
  });

  it("persists a partial fold set while preserving connection flags", async () => {
    const test = harness("POST", "/plugins/quota/fold", { folded: ["kimi", "claude"] });
    await handleFold(test.req, test.res, test.ctx, test.serializeSettings);
    expect(test.writeJson).toHaveBeenCalledWith("quota", "settings", {
      claudeConnected: true,
      cursorConnected: false,
      foldedProviders: ["claude", "kimi"],
    });
    expect(test.writes).toEqual([{ status: 200, payload: { foldedProviders: ["claude", "kimi"] } }]);
  });

  // 접힘은 순서와 달리 부분집합이다 — 완전한 순열을 요구하면 "전부 펼침"을 보낼 길이 없다.
  it("accepts an empty fold set as the way to expand everything", async () => {
    const test = harness("POST", "/plugins/quota/fold", { folded: [] });
    await handleFold(test.req, test.res, test.ctx, test.serializeSettings);
    expect(test.writeJson).toHaveBeenCalledWith("quota", "settings", {
      claudeConnected: true,
      cursorConnected: false,
      foldedProviders: [],
    });
    expect(test.writes[0]?.status).toBe(200);
  });

  it("rejects duplicated, unknown, oversized, or non-array fold sets", async () => {
    const invalid: unknown[] = [
      ["claude", "claude"],
      ["claude", "bogus"],
      ["claude", "codex", "xai", "cursor", "opencode", "kimi", "antigravity", "claude"],
      "claude",
      null,
    ];
    for (const folded of invalid) {
      const test = harness("POST", "/plugins/quota/fold", { folded });
      await handleFold(test.req, test.res, test.ctx, test.serializeSettings);
      expect(test.writes, JSON.stringify(folded)).toEqual([{ status: 400, payload: { error: "invalid_fold_request" } }]);
      expect(test.writeJson, JSON.stringify(folded)).not.toHaveBeenCalled();
    }
  });

  // retainedSettings는 화이트리스트다. 새 키가 거기 없으면 다른 경로의 저장이 그것을
  // 조용히 지운다 — 카드를 한 번 끌어다 놓거나 Claude를 연결하는 순간 접힘이 사라진다.
  it("keeps a stored fold set when the order or a connection flag changes", async () => {
    const foldedProviders = ["claude", "kimi"];
    const order = ["kimi", "claude", "codex", "xai", "cursor", "opencode", "antigravity"];

    const dragged = harness("POST", "/plugins/quota/order", { order });
    dragged.readJson.mockResolvedValue({ claudeConnected: true, foldedProviders });
    await handleOrder(dragged.req, dragged.res, dragged.ctx, dragged.serializeSettings);
    expect(dragged.writeJson).toHaveBeenCalledWith("quota", "settings", {
      claudeConnected: true,
      foldedProviders,
      providerOrder: order,
    });

    const connected = harness("POST", "/plugins/quota/connect", { provider: "cursor", connected: true });
    connected.readJson.mockResolvedValue({ claudeConnected: true, foldedProviders });
    await handleConnect(connected.req, connected.res, connected.ctx, connected.service, connected.serializeSettings);
    expect(connected.writeJson).toHaveBeenCalledWith("quota", "settings", {
      claudeConnected: true,
      cursorConnected: true,
      foldedProviders,
    });
  });

  it("guards the fold route with the same method, auth, and media-type gates as the others", async () => {
    const wrongMethod = harness("GET", "/plugins/quota/fold", { folded: [] });
    await handleFold(wrongMethod.req, wrongMethod.res, wrongMethod.ctx, wrongMethod.serializeSettings);
    expect(wrongMethod.writes).toEqual([{ status: 405, payload: { error: "method_not_allowed" } }]);

    const wrongType = harness("POST", "/plugins/quota/fold", { folded: [] }, "text/plain");
    await handleFold(wrongType.req, wrongType.res, wrongType.ctx, wrongType.serializeSettings);
    expect(wrongType.writes).toEqual([{ status: 415, payload: { error: "unsupported_media_type" } }]);

    const unauthorized = harness("POST", "/plugins/quota/fold", { folded: [] });
    (unauthorized.ctx.host.security as unknown as { isTerminalAuthorized: () => boolean }).isTerminalAuthorized = () => false;
    await handleFold(unauthorized.req, unauthorized.res, unauthorized.ctx, unauthorized.serializeSettings);
    expect(unauthorized.writes).toEqual([{ status: 401, payload: { error: "unauthorized" } }]);
    expect(unauthorized.writeJson).not.toHaveBeenCalled();
  });

  it("requires the exact JSON media type while accepting parameters", async () => {
    const jsonp = harness(
      "POST",
      "/plugins/quota/connect",
      { provider: "claude", connected: true },
      "application/jsonp",
    );
    await handleConnect(jsonp.req, jsonp.res, jsonp.ctx, jsonp.service, jsonp.serializeSettings);
    expect(jsonp.writes).toEqual([{ status: 415, payload: { error: "unsupported_media_type" } }]);
    expect(jsonp.writeJson).not.toHaveBeenCalled();

    const charset = harness(
      "POST",
      "/plugins/quota/connect",
      { provider: "claude", connected: true },
      "Application/JSON; charset=utf-8",
    );
    await handleConnect(charset.req, charset.res, charset.ctx, charset.service, charset.serializeSettings);
    expect(charset.writes[0]?.status).toBe(200);
    expect(charset.writeJson).toHaveBeenCalledOnce();
  });
});
