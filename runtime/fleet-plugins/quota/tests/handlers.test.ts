import type { IncomingMessage, ServerResponse } from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { QuotaService } from "@fleet-console/ai-gateway";
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
  const readJson = vi.fn(async (): Promise<Record<string, unknown>> => ({ claudeConnected: true }));
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

  it("rejects connection to a removed provider", async () => {
    const test = harness("POST", "/plugins/quota/connect", { provider: "cursor", connected: true });
    await handleConnect(test.req, test.res, test.ctx, test.service, test.serializeSettings);
    expect(test.writes).toEqual([{ status: 400, payload: { error: "invalid_connect_request" } }]);
    expect(test.writeJson).not.toHaveBeenCalled();
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
