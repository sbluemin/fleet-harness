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
});
