import type { IncomingMessage, ServerResponse } from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import { handleConnect, handleSummary } from "../server/handlers.js";
import type { QuotaService } from "../server/service.js";

function harness(method: string, url = "/plugins/quota/summary", body: unknown = null) {
  const writes: Array<{ status: number; payload: unknown }> = [];
  const writeJson = vi.fn(async () => {});
  const ctx = {
    host: {
      security: { isTerminalAuthorized: () => true },
      storage: { writeJson },
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, payload: unknown) => writes.push({ status, payload }),
      },
    },
  } as unknown as FleetPluginServerContext;
  const req = {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json" },
  } as IncomingMessage;
  const service = {
    getSummary: vi.fn(async () => ({
      providers: {
        claude: { status: "ok", windows: [{ id: "session", usedPercent: 1 }], fetchedAt: 10 },
        codex: { status: "signed_out" },
      },
    })),
  } as unknown as QuotaService;
  return { ctx, req, res: {} as ServerResponse, service, writes, writeJson };
}

describe("quota route handlers", () => {
  it("accepts only force=1 and emits a credential-free DTO", async () => {
    const test = harness("GET", "/plugins/quota/summary?force=1");
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.service.getSummary).toHaveBeenCalledWith({ force: true });
    const json = JSON.stringify(test.writes[0]?.payload);
    expect(json).not.toMatch(/accessToken|access_token|account_id|Users|\\\\Users/);
  });

  it("updates only the Claude connection flag and returns a forced summary", async () => {
    const test = harness("POST", "/plugins/quota/connect", { provider: "claude", connected: true });
    await handleConnect(test.req, test.res, test.ctx, test.service);
    expect(test.writeJson).toHaveBeenCalledWith("quota", "settings", { claudeConnected: true });
    expect(test.service.getSummary).toHaveBeenCalledWith({ force: true });
    expect(test.writes[0]?.status).toBe(200);
  });

  it("rejects malformed bodies and wrong methods", async () => {
    const malformed = harness("POST", "/plugins/quota/connect", { provider: "codex", connected: true });
    await handleConnect(malformed.req, malformed.res, malformed.ctx, malformed.service);
    expect(malformed.writes).toEqual([{ status: 400, payload: { error: "invalid_connect_request" } }]);
    expect(malformed.writeJson).not.toHaveBeenCalled();

    const wrongMethod = harness("POST");
    await handleSummary(wrongMethod.req, wrongMethod.res, wrongMethod.ctx, wrongMethod.service);
    expect(wrongMethod.writes[0]?.status).toBe(405);
  });
});
