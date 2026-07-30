import type { IncomingMessage, ServerResponse } from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import { handleConnect, handleSummary } from "../server/handlers.js";
import type { SettingsSerializer } from "../server/handlers.js";
import type { QuotaService } from "../server/service.js";

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
  const readJson = vi.fn(async () => ({ claudeConnected: true, cursorConnected: false }));
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
