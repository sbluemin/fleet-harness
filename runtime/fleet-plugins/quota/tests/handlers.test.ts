import type { IncomingMessage, ServerResponse } from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { QuotaService } from "@fleet-console/ai-gateway";
import { describe, expect, it, vi } from "vitest";

import { handleConnect, handleMuseLogin, handleSummary } from "../server/handlers.js";
import type { MuseLoginGateway, SettingsSerializer } from "../server/handlers.js";

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

  it("guards the settings-writing connect route with method, auth, and media-type gates", async () => {
    const request = { provider: "claude", connected: true };
    const wrongMethod = harness("GET", "/plugins/quota/connect", request);
    await handleConnect(wrongMethod.req, wrongMethod.res, wrongMethod.ctx, wrongMethod.service, wrongMethod.serializeSettings);
    expect(wrongMethod.writes).toEqual([{ status: 405, payload: { error: "method_not_allowed" } }]);

    const wrongType = harness("POST", "/plugins/quota/connect", request, "text/plain");
    await handleConnect(wrongType.req, wrongType.res, wrongType.ctx, wrongType.service, wrongType.serializeSettings);
    expect(wrongType.writes).toEqual([{ status: 415, payload: { error: "unsupported_media_type" } }]);

    const unauthorized = harness("POST", "/plugins/quota/connect", request);
    (unauthorized.ctx.host.security as unknown as { isTerminalAuthorized: () => boolean }).isTerminalAuthorized = () => false;
    await handleConnect(unauthorized.req, unauthorized.res, unauthorized.ctx, unauthorized.service, unauthorized.serializeSettings);
    expect(unauthorized.writes).toEqual([{ status: 401, payload: { error: "unauthorized" } }]);
    expect(unauthorized.writeJson).not.toHaveBeenCalled();
  });

  it("forwards Muse Code sign-in calls to Console only for authorized callers", async () => {
    // 프록시는 서버 자신의 Origin으로 Gateway를 부른다 — 브라우저 호출자를 거르는 문은 이 라우트뿐이다.
    const gateway = { call: vi.fn(async () => ({ status: 200, payload: { signedIn: false } })) } satisfies MuseLoginGateway;
    for (const [method, url, action] of [
      ["POST", "/plugins/quota/muse-code/logout", "logout"],
      ["GET", "/plugins/quota/muse-code/status?loginId=abc", "status"],
    ] as const) {
      const denied = harness(method, url, {});
      (denied.ctx.host.security as unknown as { isTerminalAuthorized: () => boolean }).isTerminalAuthorized = () => false;
      await handleMuseLogin(denied.req, denied.res, denied.ctx, action, gateway, denied.service);
      expect(denied.writes).toEqual([{ status: 401, payload: { error: "unauthorized" } }]);
    }
    expect(gateway.call).not.toHaveBeenCalled();

    const allowed = harness("POST", "/plugins/quota/muse-code/logout", {});
    await handleMuseLogin(allowed.req, allowed.res, allowed.ctx, "logout", gateway, allowed.service);
    expect(gateway.call).toHaveBeenCalledWith("logout", { body: {} });
    expect(allowed.writes[0]?.status).toBe(200);
  });
});
