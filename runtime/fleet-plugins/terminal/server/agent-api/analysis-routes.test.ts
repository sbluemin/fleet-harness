import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@dotobokuri/fleet-analyst", () => ({ AnalystSession: class {} }));

import { AnalysisRegistry, MAX_ANALYSIS_SESSIONS } from "./analysis-registry.js";
import { registerAnalysisRoutes } from "./analysis-routes.js";
import { ANALYSIS_ERROR_CODES, buildAnalysisCatalog, isAnalysisSelection, isMessageBody, type AnalystCliId } from "./analysis-types.js";

describe("Session Analyst server contract", () => {
  it("maps detected binaries to a non-sensitive authoritative catalog and rejects stale selections", () => {
    const modelsFor = vi.fn((_cliId: AnalystCliId) => ({ defaultModel: "model-a", models: [{ modelId: "model-a", name: "Model A", effort: { supported: true, levels: ["low"], default: "low" } }] }));
    const catalog = buildAnalysisCatalog([
      { id: "claude", displayName: "Claude Code", available: true, version: "1.2.3" },
      { id: "codex", displayName: "Codex CLI", available: true, version: "1.2.3" },
      { id: "opencode", displayName: "OpenCode", available: true, version: "1.2.3" },
      { id: "cursor-agent", displayName: "Cursor Agent", available: true, version: "1.2.3" },
    ], modelsFor);
    expect(catalog.clis.map((cli) => cli.cliId)).toEqual(["claude", "claude-kimi", "codex", "opencode-go", "cursor"]);
    expect(catalog.clis).toEqual(expect.arrayContaining([expect.objectContaining({ cliId: "claude", available: true })]));
    // claude 바이너리 하나가 claude-kimi 백엔드도 제공한다 — 카탈로그에 함께 광고돼야 한다.
    expect(catalog.clis).toEqual(expect.arrayContaining([expect.objectContaining({ cliId: "claude-kimi", label: "Kimi (Claude Code)", available: true })]));
    expect(JSON.stringify(catalog)).not.toMatch(/path|version|session/i);
    expect(modelsFor.mock.calls.map(([cliId]) => cliId)).toEqual(["claude", "claude-kimi", "codex", "opencode-go", "cursor"]);
    for (const cliId of ["claude", "claude-kimi", "codex", "opencode-go", "cursor"] as const) {
      expect(isAnalysisSelection(catalog, { cliId, model: "model-a", effort: "low" })).toBe(true);
    }
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "model-a" })).toBe(false);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "removed", effort: "low" })).toBe(false);

    const noEffortCatalog = buildAnalysisCatalog([
      { id: "claude", displayName: "Claude Code", available: true, version: "1.2.3" },
    ], () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }));
    expect(isAnalysisSelection(noEffortCatalog, { cliId: "claude", model: "model-b" })).toBe(true);
    expect(isAnalysisSelection(noEffortCatalog, { cliId: "claude", model: "model-b", effort: "" })).toBe(true);
    expect(isAnalysisSelection(noEffortCatalog, { cliId: "claude", model: "model-b", effort: "low" })).toBe(false);
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

  it("streams a generic analysis_error without exposing send rejection details", async () => {
    const registry = new AnalysisRegistry();
    const rejectionDetails = [
      "/Users/alice/private/project",
      "Bearer sk-proj-private-token",
      "https://127.0.0.1:8123/mcp?token=private",
      "session 123e4567-e89b-42d3-a456-426614174000",
    ];
    const events: unknown[] = [];
    await registry.start("op", () => ({
      start: async () => undefined,
      send: async () => { throw new Error(rejectionDetails.join(" ")); },
      dispose: async () => undefined,
    }) as never);
    const unsubscribe = registry.subscribe("op", (event) => events.push(event));

    await expect(registry.message("op", "review this")).resolves.toBe("accepted");
    await vi.waitFor(() => expect(events).toEqual([{
      type: "error",
      error: { code: "analysis_error", message: "Analysis request failed." },
    }]));
    const exposed = JSON.stringify(events);
    for (const detail of rejectionDetails) expect(exposed).not.toContain(detail);

    unsubscribe?.();
    await registry.stop("op");
  });

  it("disposes and releases a session stopped while start is pending", async () => {
    const registry = new AnalysisRegistry();
    let resolveStart: (() => void) | undefined;
    const dispose = vi.fn(async () => undefined);
    const start = registry.start("op", () => ({
      start: () => new Promise<void>((resolve) => { resolveStart = resolve; }),
      send: async () => undefined,
      dispose,
    }) as never);

    await expect(registry.stop("op")).resolves.toBe(true);
    resolveStart?.();
    await expect(start).resolves.toBe("stopped");
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(registry.start("op", () => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }) as never)).resolves.toBe("started");
  });

  it("releases a session after an analysis_exited event", async () => {
    const registry = new AnalysisRegistry();
    let emit: ((event: { type: "error"; error: { code: string; message: string } }) => void) | undefined;
    const dispose = vi.fn(async () => undefined);
    await registry.start("op", (onEvent) => {
      emit = onEvent;
      return { start: async () => undefined, send: async () => undefined, dispose } as never;
    });

    emit?.({ type: "error", error: { code: "analysis_exited", message: "exited" } });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    await expect(registry.message("op", "hello")).resolves.toBe("not_found");
  });

  it("normalizes absent effort to undefined when creating an unsupported-effort session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-transcripts-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath }),
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined }));
  });

  it("reports analysis as not ready when no provider capture exists", async () => {
    const router = createRouterHarness(true);
    registerAnalysisRoutes(router.ctx as never, { readCapture: () => null });

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");

    expect(router.responses.at(-1)).toEqual({ status: 200, body: { ready: false } });
  });

  it("reports analysis as ready when the captured transcript exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-ready-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    registerAnalysisRoutes(router.ctx as never, {
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath }),
    });

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");

    expect(router.responses.at(-1)).toEqual({ status: 200, body: { ready: true } });
    expect(JSON.stringify(router.responses.at(-1))).not.toContain(transcriptPath);
  });

  it("reports analysis as ready when transcript fallback resolution succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-ready-fallback-"));
    const fallbackPath = join(dir, "active-session.jsonl");
    await writeFile(fallbackPath, "{}\n");
    const router = createRouterHarness(true);
    registerAnalysisRoutes(router.ctx as never, {
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath: join(dir, "missing-session.jsonl") }),
    });

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");

    expect(router.responses.at(-1)).toEqual({ status: 200, body: { ready: true } });
    expect(JSON.stringify(router.responses.at(-1))).not.toContain(fallbackPath);
  });

  it("fails closed when multiple sibling transcripts pass the birthtime cutoff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-transcripts-"));
    await writeFile(join(dir, "session-a.jsonl"), "{}\n");
    await writeFile(join(dir, "session-b.jsonl"), "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath: join(dir, "hook-session.jsonl") }),
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    expect(router.responses.at(-1)).toMatchObject({ status: 409, body: { error: { code: "analysis_transcript_missing" } } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("uses a single sibling transcript that passes the birthtime cutoff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-transcripts-"));
    const activePath = join(dir, "active-session.jsonl");
    await writeFile(activePath, "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath: join(dir, "hook-session.jsonl") }),
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ capturePath: activePath }));
  });

  it("writes connected and frozen error envelopes for a missing-session stream", async () => {
    const router = createRouterHarness(true);
    registerAnalysisRoutes(router.ctx as never);

    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/op/stream");
    expect(response.writes).toEqual([
      "data: {\"type\":\"connected\"}\n\n",
      `data: ${JSON.stringify({ type: "error", error: { code: "analysis_session_not_found", message: "Analysis session was not found." } })}\n\n`,
    ]);
    expect(response.ended).toBe(true);
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

  it("rejects a malicious Origin through the shared gate for every analysis action", async () => {
    const detect = vi.fn(async () => []);
    const router = createRouterHarness(true);
    registerAnalysisRoutes(router.ctx as never, { detect });
    const requests = [
      ["GET", "/api/v1/plugins/terminal/analysis/catalog"],
      ["GET", "/api/v1/plugins/terminal/analysis/op/ready"],
      ["POST", "/api/v1/plugins/terminal/analysis/op/start"],
      ["POST", "/api/v1/plugins/terminal/analysis/op/message"],
      ["GET", "/api/v1/plugins/terminal/analysis/op/stream"],
      ["POST", "/api/v1/plugins/terminal/analysis/op/stop"],
    ] as const;

    for (const [method, pathname] of requests) {
      await router.call(method, pathname, {}, { origin: "https://evil.example" });
    }

    expect(router.responses).toHaveLength(requests.length);
    expect(router.responses).toEqual(requests.map(() => ({ status: 403, body: { error: { code: "analysis_catalog_invalid", message: "Analysis request is not accepted by this host." } } })));
    expect(detect).not.toHaveBeenCalled();
  });
});

function createRouterHarness(initialHostAllowance: boolean) {
  let handler: ((context: { req: EventEmitter & { method: string; headers: Record<string, string>; socket: { localPort: number } }; res: EventEmitter; pathname: string }) => Promise<boolean>) | undefined;
  const responses: Array<{ status: number; body: unknown }> = [];
  const state = { allowHost: initialHostAllowance };
  const operation = { id: "op", pluginId: "terminal", type: "agent", theaterId: "theater", payload: {}, ts: { createdAt: 0, updatedAt: 0 } };
  const ctx = {
    pluginId: "terminal", basePath: "/api/v1/plugins/terminal",
    registerRouter: (_path: string, registered: typeof handler) => { handler = registered; },
    host: {
      security: {
        validateHost: () => state.allowHost,
        isTerminalAuthorized: (req: { headers: Record<string, string> }) => req.headers.origin !== "https://evil.example",
      },
      http: { writeJson: (_res: EventEmitter, status: number, body: unknown) => responses.push({ status, body }), readJsonBody: async (req: EventEmitter & { body?: unknown }) => req.body ?? null },
      operations: { get: (id: string) => id === "op" ? operation : null },
      paths: { capturesDir: "/capture", resolveTheaterPath: () => "/theater" },
      events: { subscribe: () => () => undefined }, lifecycle: { registerCleanup: () => () => undefined },
    },
  };
  return {
    ctx, responses,
    get allowHost() { return state.allowHost; }, set allowHost(value: boolean) { state.allowHost = value; },
    async call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
      const writes: string[] = [];
      let ended = false;
      const req = Object.assign(new EventEmitter(), { method, headers: { "content-type": "application/json", ...headers }, socket: { localPort: 4444 }, body });
      const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, writeHead: () => undefined, write: (data: string) => { writes.push(data); }, end: () => { ended = true; } });
      await handler?.({ req, res, pathname });
      return { writes, get ended() { return ended; } };
    },
  };
}
