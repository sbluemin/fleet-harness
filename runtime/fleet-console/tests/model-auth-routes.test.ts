import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createModelAuthRouter } from "../src/model-auth-routes.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface ValidationResult {
  readonly providerId: string;
  readonly status: string;
  readonly detail?: string;
}

interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly signedIn?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly validation?: ValidationResult;
}

const KIMI_PROVIDER_ID = "Claude Code with Moonshot Kimi";
const KIMI_PATH = "/model-auth/providers/claude-kimi";

describe("model auth routes", () => {
  it("GET /model-auth/state reports the kimi provider and reflects signed-in status", async () => {
    const harness = createRouterHarness({ signedIn: true });
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/model-auth/state" });
    expect(handled).toBe(true);
    const body = harness.writes[0]?.body as { providers: Array<{ cli: string; signedIn: boolean }> };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({ cli: "claude-kimi", signedIn: true });
  });

  it("GET /model-auth/state never serializes the api key or the internal provider storage key", async () => {
    const harness = createRouterHarness({ signedIn: true });
    await harness.router({ req: req("GET"), res: res(), pathname: "/model-auth/state" });
    const serialized = JSON.stringify(harness.writes);
    expect(serialized).not.toContain("stored-key");
    expect(serialized).not.toContain(KIMI_PROVIDER_ID);
    expect(serialized).toContain("\"signedIn\":true");
  });

  it("GET /model-auth/state rejects non-GET methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("POST"), res: res(), pathname: "/model-auth/state" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("PUT validates then stores the api key and returns signed-in state", async () => {
    const harness = createRouterHarness({ authorized: true, body: { apiKey: "sk-live" } });
    const handled = await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(handled).toBe(true);
    expect(harness.validateCalls).toBe(1);
    expect(harness.setCalls).toBe(1);
    expect(harness.store.get(KIMI_PROVIDER_ID)).toBe("sk-live");
    const body = harness.writes[0]?.body as { state: { providers: Array<{ signedIn: boolean }> } };
    expect(body.state.providers[0]?.signedIn).toBe(true);
  });

  it("PUT trims the api key before validating and storing", async () => {
    const harness = createRouterHarness({ authorized: true, body: { apiKey: "  sk-pad  " } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(harness.store.get(KIMI_PROVIDER_ID)).toBe("sk-pad");
  });

  it("PUT rejects a key the provider refuses with 400 and does not store it", async () => {
    const harness = createRouterHarness({
      authorized: true,
      body: { apiKey: "bad" },
      validation: { providerId: KIMI_PROVIDER_ID, status: "unauthorized" },
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.setCalls).toBe(0);
  });

  it("PUT failure messages never leak the internal provider storage key", async () => {
    const harness = createRouterHarness({
      authorized: true,
      body: { apiKey: "bad" },
      validation: { providerId: KIMI_PROVIDER_ID, status: "unauthorized" },
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    const serialized = JSON.stringify(harness.writes);
    expect(serialized).not.toContain(KIMI_PROVIDER_ID);
    expect(serialized).toContain("Moonshot Kimi");
  });

  it("PUT maps upstream validation failures to 502", async () => {
    const harness = createRouterHarness({
      authorized: true,
      body: { apiKey: "x" },
      validation: { providerId: KIMI_PROVIDER_ID, status: "network", detail: "boom" },
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(502);
    expect(harness.setCalls).toBe(0);
  });

  it("PUT rejects unauthorized requests with 401 before validating or storing", async () => {
    const harness = createRouterHarness({ authorized: false, body: { apiKey: "x" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.validateCalls).toBe(0);
    expect(harness.setCalls).toBe(0);
  });

  it("PUT rejects non-JSON content types with 415", async () => {
    const harness = createRouterHarness({ authorized: true });
    await harness.router({ req: req("PUT", "text/plain"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.setCalls).toBe(0);
  });

  it("PUT rejects an empty api key with 400 without contacting the provider", async () => {
    const harness = createRouterHarness({ authorized: true, body: { apiKey: "   " } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.validateCalls).toBe(0);
    expect(harness.setCalls).toBe(0);
  });

  it("rejects providers outside the kimi whitelist with 404", async () => {
    const harness = createRouterHarness({ authorized: true, body: { apiKey: "x" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/model-auth/providers/claude-zai" });
    expect(harness.writes[0]?.status).toBe(404);
    expect(harness.setCalls).toBe(0);
  });

  it("DELETE signs out the provider and reports signedIn false", async () => {
    const harness = createRouterHarness({ authorized: true, signedIn: true });
    await harness.router({ req: req("DELETE"), res: res(), pathname: KIMI_PATH });
    expect(harness.deleteCalls).toBe(1);
    const body = harness.writes[0]?.body as { state: { providers: Array<{ signedIn: boolean }> } };
    expect(body.state.providers[0]?.signedIn).toBe(false);
  });

  it("DELETE rejects unauthorized requests with 401", async () => {
    const harness = createRouterHarness({ authorized: false, signedIn: true });
    await harness.router({ req: req("DELETE"), res: res(), pathname: KIMI_PATH });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.deleteCalls).toBe(0);
  });

  it("GET /model-auth/state migrates legacy auth before reading sign-in state", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("GET"), res: res(), pathname: "/model-auth/state" });
    expect(harness.migrateCalls).toBe(1);
  });

  it("DELETE deletes from the current store only and does not migrate legacy (legacy purge is out of PR scope)", async () => {
    const harness = createRouterHarness({ authorized: true, signedIn: true });
    await harness.router({ req: req("DELETE"), res: res(), pathname: KIMI_PATH });
    expect(harness.deleteCalls).toBe(1);
    expect(harness.migrateCalls).toBe(0);
  });

  it("returns false for the bare providers path so the host can fall through", async () => {
    const harness = createRouterHarness();
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/model-auth/providers" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
  });
});

function createRouterHarness(options: RouterHarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const store = new Map<string, string>(options.signedIn ? [[KIMI_PROVIDER_ID, "stored-key"]] : []);
  let validateCalls = 0;
  let setCalls = 0;
  let deleteCalls = 0;
  let migrateCalls = 0;
  const router = createModelAuthRouter({
    authService: {
      setApiKey: async (providerId, apiKey) => { setCalls += 1; store.set(providerId, apiKey); },
      deleteApiKey: async (providerId) => { deleteCalls += 1; return store.delete(providerId); },
      listProviderIds: async () => [...store.keys()],
    },
    validateApiKey: async () => {
      validateCalls += 1;
      return (options.validation ?? { providerId: KIMI_PROVIDER_ID, status: "success" }) as never;
    },
    migrateLegacyAuth: async () => { migrateCalls += 1; return {}; },
    isAuthorized: () => options.authorized ?? true,
    readJsonBody: async () => (options.bodyNull ? null : (options.body ?? { apiKey: "sk-test" })) as never,
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
  });
  return {
    router,
    writes,
    store,
    get validateCalls() { return validateCalls; },
    get setCalls() { return setCalls; },
    get deleteCalls() { return deleteCalls; },
    get migrateCalls() { return migrateCalls; },
  };
}

function req(method: string, contentType?: string): http.IncomingMessage {
  return { method, headers: contentType ? { "content-type": contentType } : {} } as unknown as http.IncomingMessage;
}

function jsonReq(method: string): http.IncomingMessage {
  return req(method, "application/json");
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}
