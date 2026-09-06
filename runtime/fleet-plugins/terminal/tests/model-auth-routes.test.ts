import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it } from "vitest";

import { createTerminalModelAuthRouter } from "../server/model-auth-routes.js";

interface WriteJsonCall { readonly status: number; readonly body: unknown }
interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly signedIn?: boolean;
  readonly opencodeSignedIn?: boolean;
  readonly body?: unknown;
  readonly validationStatus?: "success" | "unauthorized" | "network";
}

const BASE_PATH = "/plugins/terminal";
const KIMI_PROVIDER_ID = "Claude Code with Moonshot Kimi";
const OPENCODE_PROVIDER_ID = "Claude Code with OpenCode Go";
const KIMI_PATH = `${BASE_PATH}/model-auth/providers/kimi`;
const OPENCODE_PATH = `${BASE_PATH}/model-auth/providers/opencode`;

describe("terminal model auth routes", () => {
  it("returns browser-safe boolean state", async () => {
    const harness = createRouterHarness({ signedIn: true });
    await harness.router({ req: req("GET"), res: res(), pathname: `${BASE_PATH}/model-auth/state` });

    expect(harness.writes[0]).toMatchObject({
      status: 200,
      body: {
        providers: [
          { provider: "kimi", displayName: "Kimi for AI Gateway", signedIn: true },
          { provider: "opencode", displayName: "OpenCode Go for AI Gateway", signedIn: false },
        ],
      },
    });
    const serialized = JSON.stringify(harness.writes);
    expect(serialized).not.toContain(KIMI_PROVIDER_ID);
    expect(serialized).not.toContain(OPENCODE_PROVIDER_ID);
    expect(serialized).not.toContain("stored-key");
  });

  it("does not store a rejected key or leak the storage provider ID", async () => {
    const harness = createRouterHarness({ body: { apiKey: "bad" }, validationStatus: "unauthorized" });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });

    expect(harness.store.size).toBe(0);
    expect(harness.writes[0]?.status).toBe(400);
    expect(JSON.stringify(harness.writes)).not.toContain(KIMI_PROVIDER_ID);
  });

  it("maps provider network failures to 502", async () => {
    const harness = createRouterHarness({ body: { apiKey: "x" }, validationStatus: "network" });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(502);
  });

  it("requires terminal authorization for mutations", async () => {
    const harness = createRouterHarness({ authorized: false, body: { apiKey: "x" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.validatedKeys).toEqual([]);
  });
});

function createRouterHarness(options: RouterHarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const validatedKeys: [string, string][] = [];
  const store = new Map<string, string>([
    ...(options.signedIn ? [[KIMI_PROVIDER_ID, "stored-key"] as const] : []),
    ...(options.opencodeSignedIn ? [[OPENCODE_PROVIDER_ID, "stored-key"] as const] : []),
  ]);
  const ctx = createContext({
    writes,
    authorized: options.authorized ?? true,
    readBody: async () => options.body ?? { apiKey: "kimi-secret" },
  });
  const router = createTerminalModelAuthRouter(ctx, {
    authService: {
      setApiKey: async (providerId, apiKey) => { store.set(providerId, apiKey); },
      deleteApiKey: async (providerId) => store.delete(providerId),
      listProviderIds: async () => [...store.keys()],
    },
    validateApiKey: async (provider, apiKey) => {
      validatedKeys.push([provider, apiKey]);
      return { providerId: KIMI_PROVIDER_ID, status: options.validationStatus ?? "success" };
    },
  });
  return { router, writes, store, validatedKeys };
}

function createContext(options: {
  readonly writes: WriteJsonCall[];
  readonly authorized: boolean;
  readonly readBody: () => Promise<unknown>;
}): FleetPluginServerContext {
  return {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: BASE_PATH,
    wsBasePath: `${BASE_PATH}/ws`,
    host: {
      http: {
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => options.writes.push({ status, body }),
        readJsonBody: options.readBody,
      },
      security: { isTerminalAuthorized: () => options.authorized },
    },
  } as unknown as FleetPluginServerContext;
}

function req(method: string, contentType?: string): http.IncomingMessage {
  return { method, headers: contentType ? { "content-type": contentType } : {} } as unknown as http.IncomingMessage;
}

function jsonReq(method: string): http.IncomingMessage { return req(method, "application/json"); }
function res(): http.ServerResponse { return {} as http.ServerResponse; }
