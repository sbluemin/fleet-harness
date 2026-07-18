import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

vi.mock("@dotobokuri/fleet-analyst", () => ({ AnalystSession: class {} }));

import { AnalysisRegistry, MAX_ANALYSIS_SESSIONS } from "./analysis-registry.js";
import { registerAnalysisRoutes } from "./analysis-routes.js";
import { ANALYSIS_ERROR_CODES, buildAnalysisCatalog, isAnalysisSelection, isMessageBody } from "./analysis-types.js";

describe("Session Analyst server contract", () => {
  it("maps detected binaries to a non-sensitive authoritative catalog and rejects stale selections", () => {
    const catalog = buildAnalysisCatalog([
      { id: "claude", displayName: "Claude Code", available: true, version: "1.2.3" },
      { id: "codex", displayName: "Codex CLI", available: false, version: null },
    ], () => ({ defaultModel: "model-a", models: [{ modelId: "model-a", name: "Model A", effort: { supported: true, levels: ["low"], default: "low" } }] }));
    expect(catalog.clis).toEqual(expect.arrayContaining([expect.objectContaining({ cliId: "claude", available: true })]));
    expect(JSON.stringify(catalog)).not.toMatch(/path|version|session/i);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "model-a", effort: "low" })).toBe(true);
    expect(isAnalysisSelection(catalog, { cliId: "codex", model: "model-a", effort: "low" })).toBe(false);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "removed", effort: "low" })).toBe(false);
  });

  it("accepts only the frozen message shape", () => {
    expect(isMessageBody({ text: "review this" })).toBe(true);
    expect(isMessageBody({ text: "", extra: true })).toBe(false);
    expect(ANALYSIS_ERROR_CODES.transcriptMissing).toBe("analysis_transcript_missing");
  });

  it("caps sessions, serializes messages, and disposes idempotently", async () => {
    const registry = new AnalysisRegistry();
    let resolveTurn: (() => void) | undefined;
    const sessions = Array.from({ length: MAX_ANALYSIS_SESSIONS }, () => ({
      start: async () => undefined,
      send: () => new Promise<void>((resolve) => { resolveTurn = resolve; }),
      dispose: async () => undefined,
    }));
    for (let index = 0; index < MAX_ANALYSIS_SESSIONS; index += 1) {
      await expect(registry.start(`op-${index}`, () => sessions[index]! as never)).resolves.toBe("started");
    }
    await expect(registry.start("overflow", () => sessions[0]! as never)).resolves.toBe("limit");
    await expect(registry.message("op-0", "hello")).resolves.toBe("accepted");
    await expect(registry.message("op-0", "again")).resolves.toBe("busy");
    resolveTurn?.();
    await Promise.resolve();
    await expect(registry.stop("op-0")).resolves.toBe(true);
    await expect(registry.stop("op-0")).resolves.toBe(false);
  });

  it("validates Host before route work and never reveals unavailable capture paths", async () => {
    const router = createRouterHarness(false);
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-a", models: [{ modelId: "model-a", name: "Model A", effort: { supported: true, levels: ["low"], default: "low" } }] }) as never,
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now" }),
    });
    await router.call("GET", "/api/v1/plugins/terminal/analysis/catalog");
    expect(router.responses.at(-1)).toMatchObject({ status: 403, body: { error: { code: "analysis_catalog_invalid" } } });

    router.allowHost = true;
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-a", effort: "low" });
    expect(router.responses.at(-1)).toMatchObject({ status: 409, body: { error: { code: "analysis_transcript_missing" } } });
    expect(JSON.stringify(router.responses)).not.toContain("private");
  });
});

function createRouterHarness(initialHostAllowance: boolean) {
  let handler: ((context: { req: EventEmitter & { method: string; headers: Record<string, string>; socket: { localPort: number } }; res: EventEmitter; pathname: string }) => Promise<boolean>) | undefined;
  const responses: Array<{ status: number; body: unknown }> = [];
  const state = { allowHost: initialHostAllowance };
  const operation = { id: "op", pluginId: "terminal", type: "agent", theaterId: "theater", payload: {} };
  const ctx = {
    pluginId: "terminal", basePath: "/api/v1/plugins/terminal",
    registerRouter: (_path: string, registered: typeof handler) => { handler = registered; },
    host: {
      security: { validateHost: () => state.allowHost },
      http: { writeJson: (_res: EventEmitter, status: number, body: unknown) => responses.push({ status, body }), readJsonBody: async (req: EventEmitter & { body?: unknown }) => req.body ?? null },
      operations: { get: (id: string) => id === "op" ? operation : null },
      paths: { capturesDir: "/capture", resolveTheaterPath: () => "/theater" },
      events: { subscribe: () => () => undefined }, lifecycle: { registerCleanup: () => () => undefined },
    },
  };
  return {
    ctx, responses,
    get allowHost() { return state.allowHost; }, set allowHost(value: boolean) { state.allowHost = value; },
    async call(method: string, pathname: string, body?: unknown) {
      const req = Object.assign(new EventEmitter(), { method, headers: { "content-type": "application/json" }, socket: { localPort: 4444 }, body });
      const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, writeHead: () => undefined, write: () => undefined, end: () => undefined });
      await handler?.({ req, res, pathname });
    },
  };
}
