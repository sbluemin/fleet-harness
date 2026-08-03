// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@dotobokuri/fleet-analyst", () => ({ AnalystSession: class {} }));

import { analysisArtifactUrl } from "../../client/agent/analysis-api.js";
import { AnalysisRegistry, MAX_ANALYSIS_ARTIFACTS, MAX_STOPPED_ANALYSIS_ARTIFACTS } from "./analysis-registry.js";
import { ANALYSIS_ARTIFACT_CSP, registerAnalysisRoutes } from "./analysis-routes.js";
import { ANALYSIS_ERROR_CODES, buildAnalysisCatalog, isAnalysisSelection, isMessageBody, type AnalysisEvent, type AnalystCliId } from "./analysis-types.js";
import { readProviderSession } from "./provider-session.js";

function artifactBaseCss(colors: { readonly canvas: string; readonly surface: string; readonly foreground: string; readonly muted: string; readonly hairline: string; readonly accent: string }): string {
  return `:root{--fleet-canvas:${colors.canvas};--fleet-surface:${colors.surface};--fleet-ink:${colors.foreground};--fleet-muted:${colors.muted};--fleet-hairline:${colors.hairline};--fleet-accent:${colors.accent}}a{color:var(--fleet-accent)}code{background:var(--fleet-surface);border:1px solid var(--fleet-hairline);border-radius:4px;padding:0 .3em}pre{background:var(--fleet-surface);border:1px solid var(--fleet-hairline);border-radius:8px;padding:12px;overflow-x:auto}pre code{background:none;border:none;padding:0}blockquote{border-left:3px solid var(--fleet-hairline);color:var(--fleet-muted);margin-left:0;padding-left:1em}hr{border:none;border-top:1px solid var(--fleet-hairline)}th,td{border-color:var(--fleet-hairline)}::selection{background:var(--fleet-accent);color:var(--fleet-canvas)}`;
}

describe("Session Analyst server contract", () => {
  it("serializes all Console theme colors into artifact URLs", () => {
    const url = new URL(analysisArtifactUrl("artifact/id", "carbon", "#101820", "#f2f4f7", "#18212b", "#35404d", "#65d1ff", "#96a0ad"), "http://fleet.invalid");

    expect(url.pathname).toBe("/plugins/terminal/analysis/artifacts/artifact%2Fid");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      theme: "carbon",
      canvas: "#101820",
      foreground: "#f2f4f7",
      surface: "#18212b",
      hairline: "#35404d",
      accent: "#65d1ff",
      muted: "#96a0ad",
    });
  });

  it("maps detected binaries to a non-sensitive authoritative catalog and rejects stale selections", () => {
    const modelsFor = vi.fn((_cliId: AnalystCliId) => ({ defaultModel: "model-a", models: [{ modelId: "model-a", name: "Model A", effort: { supported: true, levels: ["low"], default: "low" } }] }));
    const catalog = buildAnalysisCatalog([
      { id: "claude", displayName: "Claude Code", available: true, version: "1.2.3" },
    ], modelsFor);
    expect(catalog.clis.map((cli) => cli.cliId)).toEqual(["claude"]);
    expect(catalog.clis).toEqual(expect.arrayContaining([expect.objectContaining({ cliId: "claude", available: true })]));
    expect(JSON.stringify(catalog)).not.toMatch(/path|version|session/i);
    expect(modelsFor.mock.calls.map(([cliId]) => cliId)).toEqual(["claude"]);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "model-a", effort: "low" })).toBe(true);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "model-a", effort: "low", language: "ko" })).toBe(true);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "model-a", effort: "low", language: "ja" })).toBe(false);
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

  it("starts more than four distinct sessions, serializes messages, and disposes idempotently", async () => {
    const registry = new AnalysisRegistry();
    let resolveTurn: (() => void) | undefined;
    const sessions = Array.from({ length: 6 }, () => ({
      start: async () => undefined,
      send: () => new Promise<void>((resolve) => { resolveTurn = resolve; }),
      dispose: async () => undefined,
    }));
    for (let index = 0; index < sessions.length; index += 1) {
      await expect(registry.start(`op-${index}`, () => sessions[index]! as never)).resolves.toBe("started");
    }
    await expect(registry.message("op-0", "hello")).resolves.toBe("accepted");
    await expect(registry.message("op-0", "again")).resolves.toBe("busy");
    resolveTurn?.();
    await Promise.resolve();
    await expect(registry.stop("op-0")).resolves.toBe(true);
    await expect(registry.stop("op-0")).resolves.toBe(false);
    await registry.dispose();
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
    const globalEvents: unknown[] = [];
    const unsubscribeAll = registry.subscribeAll((operationId, event) => globalEvents.push({ operationId, event }));
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
    expect(globalEvents).toEqual([{
      operationId: "op",
      event: {
        type: "error",
        error: { code: "analysis_error", message: "Analysis request failed." },
      },
    }]);
    const exposed = JSON.stringify(events);
    for (const detail of rejectionDetails) expect(exposed).not.toContain(detail);

    unsubscribe?.();
    unsubscribeAll();
    await registry.stop("op");
  });

  it("drops a send rejection from a stopped session after the same operation restarts", async () => {
    const registry = new AnalysisRegistry();
    let rejectOldSend: ((reason?: unknown) => void) | undefined;
    const globalEvents: unknown[] = [];
    const newEntryEvents: unknown[] = [];
    const unsubscribeAll = registry.subscribeAll((operationId, event) => globalEvents.push({ operationId, event }));

    await registry.start("op", () => ({
      start: async () => undefined,
      send: () => new Promise<void>((_resolve, reject) => { rejectOldSend = reject; }),
      dispose: async () => undefined,
    }) as never);
    await expect(registry.message("op", "old request")).resolves.toBe("accepted");
    await expect(registry.stop("op")).resolves.toBe(true);
    await expect(registry.start("op", () => ({
      start: async () => undefined,
      send: async () => undefined,
      dispose: async () => undefined,
    }) as never)).resolves.toBe("started");
    const unsubscribeNewEntry = registry.subscribe("op", (event) => newEntryEvents.push(event));

    rejectOldSend?.(new Error("old session failed"));
    await Promise.resolve();
    expect(globalEvents).toEqual([]);
    expect(newEntryEvents).toEqual([]);

    unsubscribeNewEntry?.();
    unsubscribeAll();
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

  it("bounds process-memory artifacts per operation without evicting another operation", async () => {
    const registry = new AnalysisRegistry();
    type ArtifactEmitter = (event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: number } }) => void;
    let emitPrimary: ArtifactEmitter | undefined;
    let emitOther: ArtifactEmitter | undefined;
    await registry.start("op-primary", (onEvent) => {
      emitPrimary = onEvent as ArtifactEmitter;
      return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined } as never;
    });
    await registry.start("op-other", (onEvent) => {
      emitOther = onEvent as ArtifactEmitter;
      return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined } as never;
    });

    emitOther?.({ type: "artifact", artifact: { id: "other-artifact", title: "Other", html: "<p>other</p>", createdAt: 0 } });
    for (let index = 0; index <= MAX_ANALYSIS_ARTIFACTS; index += 1) {
      emitPrimary?.({ type: "artifact", artifact: { id: `primary-artifact-${index}`, title: `Artifact ${index}`, html: `<p>${index}</p>`, createdAt: index } });
    }

    expect(registry.artifactHtml("primary-artifact-0")).toBeNull();
    expect(registry.artifactHtml(`primary-artifact-${MAX_ANALYSIS_ARTIFACTS}`)).toBe(`<p>${MAX_ANALYSIS_ARTIFACTS}</p>`);
    expect(registry.artifactHtml("other-artifact")).toBe("<p>other</p>");
    await registry.stop("op-primary");
    expect(registry.artifactHtml(`primary-artifact-${MAX_ANALYSIS_ARTIFACTS}`)).toBe(`<p>${MAX_ANALYSIS_ARTIFACTS}</p>`);
    expect(registry.artifactHtml("other-artifact")).toBe("<p>other</p>");
    await registry.dispose();
    expect(registry.artifactHtml(`primary-artifact-${MAX_ANALYSIS_ARTIFACTS}`)).toBeNull();
    expect(registry.artifactHtml("other-artifact")).toBeNull();
  });

  it("bounds stopped artifact history process-wide by evicting the oldest inactive artifacts", async () => {
    const registry = new AnalysisRegistry();
    const artifactIds: string[] = [];
    const operationCount = Math.floor(MAX_STOPPED_ANALYSIS_ARTIFACTS / MAX_ANALYSIS_ARTIFACTS) + 1;

    for (let operationIndex = 0; operationIndex < operationCount; operationIndex += 1) {
      const emit = await startArtifactSession(registry, `stopped-op-${operationIndex}`);
      for (let artifactIndex = 0; artifactIndex < MAX_ANALYSIS_ARTIFACTS; artifactIndex += 1) {
        const artifactId = `stopped-${operationIndex}-${artifactIndex}`;
        artifactIds.push(artifactId);
        emitArtifact(emit, artifactId);
      }
      await registry.stop(`stopped-op-${operationIndex}`);
    }

    expect(artifactIds.filter((artifactId) => registry.artifactHtml(artifactId) !== null)).toHaveLength(MAX_STOPPED_ANALYSIS_ARTIFACTS);
    expect(registry.artifactHtml("stopped-0-0")).toBeNull();
    expect(registry.artifactHtml(`stopped-0-${MAX_ANALYSIS_ARTIFACTS - 1}`)).toBeNull();
    expect(registry.artifactHtml("stopped-1-0")).toBe("<p>stopped-1-0</p>");
    await registry.dispose();
  });

  it("never evicts active operation artifacts when enforcing the process-wide cap", async () => {
    const registry = new AnalysisRegistry();
    const artifactIds = ["active-artifact"];
    const emitActive = await startArtifactSession(registry, "active-op");
    emitArtifact(emitActive, "active-artifact");
    const stoppedOperationCount = Math.floor(MAX_STOPPED_ANALYSIS_ARTIFACTS / MAX_ANALYSIS_ARTIFACTS) + 1;

    for (let operationIndex = 0; operationIndex < stoppedOperationCount; operationIndex += 1) {
      const operationId = `history-op-${operationIndex}`;
      const emit = await startArtifactSession(registry, operationId);
      for (let artifactIndex = 0; artifactIndex < MAX_ANALYSIS_ARTIFACTS; artifactIndex += 1) {
        const artifactId = `history-${operationIndex}-${artifactIndex}`;
        artifactIds.push(artifactId);
        emitArtifact(emit, artifactId);
      }
      await registry.stop(operationId);
    }

    expect(registry.artifactHtml("active-artifact")).toBe("<p>active-artifact</p>");
    expect(artifactIds.filter((artifactId) => registry.artifactHtml(artifactId) !== null)).toHaveLength(MAX_STOPPED_ANALYSIS_ARTIFACTS + 1);
    expect(registry.artifactHtml("history-0-0")).toBeNull();
    await registry.dispose();
  });

  it("normalizes absent effort to undefined when creating an unsupported-effort session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-transcripts-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn((_options: unknown) => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b", language: "ko" });
    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined, language: "ko" }));
  });

  it("uses the configured Claude path for Analyst detection and execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-cli-path-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const readAgentCliPaths = vi.fn(async () => ({ claude: process.execPath }));
    const createSession = vi.fn((_options: unknown) => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      env: { PATH: "" },
      readAgentCliPaths,
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });

    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(readAgentCliPaths).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cliId: "claude",
      cliPath: process.execPath,
      env: { CLAUDE_BIN: process.execPath },
    }));
  });

  it("keeps an existing Analyst CLI env override ahead of a stored user path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-cli-env-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const readAgentCliPaths = vi.fn(async () => ({ claude: "/stored/path/must-not-win" }));
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      env: { PATH: "", CLAUDE_BIN: process.execPath },
      readAgentCliPaths,
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });

    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cliPath: process.execPath,
      env: undefined,
    }));
  });



  it("passes no custom env when no Agent CLI user path is stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-cli-no-path-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      env: {
        PATH: "",
        CLAUDE_BIN: process.execPath,
        CLAUDECODE: "nested",
        NODE_OPTIONS: "--inspect",
        npm_config_user_agent: "must-not-return",
      },
      readAgentCliPaths: async () => ({}),
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });

    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cliPath: process.execPath,
      env: undefined,
    }));
  });

  it("disposes a registry entry when its Operation is deleted during pending start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-pending-delete-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let resolveStart!: () => void;
    const dispose = vi.fn(async () => undefined);
    const createSession = vi.fn(() => ({
      start: () => new Promise<void>((resolve) => { resolveStart = resolve; }),
      send: async () => undefined,
      dispose,
    }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    router.deleteOperation();
    router.emitOperationDeleted({ operationId: "op", pluginId: "terminal", type: "agent" });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    resolveStart();
    await starting;

    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { code: "analysis_session_not_found" } } });
  });

  it("reports deletion-owned 404 when disposal rejects a pending start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-pending-delete-rejection-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let rejectStart!: (error: Error) => void;
    const dispose = vi.fn(async () => { rejectStart(new Error("disposed during start")); });
    const createSession = vi.fn(() => ({
      start: () => new Promise<void>((_resolve, reject) => { rejectStart = reject; }),
      send: async () => undefined,
      dispose,
    }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    router.deleteOperation();
    router.emitOperationDeleted({ operationId: "op", pluginId: "terminal", type: "agent" });
    await starting;

    expect(dispose).toHaveBeenCalledOnce();
    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { code: "analysis_session_not_found" } } });
  });

  it("does not register a session when its Operation is deleted before the final start check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-pre-registration-delete-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const statuses = [{ id: "claude", displayName: "Claude Code", available: true, version: null }] as const;
    let resolveDetect!: (value: typeof statuses) => void;
    const detection = new Promise<typeof statuses>((resolve) => { resolveDetect = resolve; });
    const detect = vi.fn(() => detection);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect,
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
    router.deleteOperation();
    resolveDetect(statuses);
    await starting;

    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { code: "analysis_session_not_found" } } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not register a session when its Operation is deleted and recreated with the same id during start preparation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-same-id-recreation-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const statuses = [{ id: "claude", displayName: "Claude Code", available: true, version: null }] as const;
    let resolveDetect!: (value: typeof statuses) => void;
    const detection = new Promise<typeof statuses>((resolve) => { resolveDetect = resolve; });
    const detect = vi.fn(() => detection);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect,
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
    router.deleteOperation();
    router.emitOperationDeleted({ operationId: "op", pluginId: "terminal", type: "agent" });
    router.recreateOperation();
    resolveDetect(statuses);
    await starting;

    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { code: "analysis_session_not_found" } } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reports analysis as not ready when no provider capture exists", async () => {
    const router = createRouterHarness(true);
    registerAnalysisRoutes(router.ctx as never);

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");

    expect(router.responses.at(-1)).toEqual({ status: 200, body: { ready: false } });
  });

  it("reports analysis as ready when the captured transcript exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-ready-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never);

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");

    expect(router.responses.at(-1)).toEqual({ status: 200, body: { ready: true } });
    expect(JSON.stringify(router.responses.at(-1))).not.toContain(transcriptPath);
  });

  it("reads a durable Codex transcript only through the analysis path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-codex-durable-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "codex", sessionId: "legacy-private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: createSession as never,
    });

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });

    expect(router.responses.at(-2)).toEqual({ status: 200, body: { ready: true } });
    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ capturePath: transcriptPath }));
    expect(readProviderSession(router.operation.payload)).toBeUndefined();
  });

  it("reports analysis as ready when transcript fallback resolution succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-ready-fallback-"));
    const fallbackPath = join(dir, "active-session.jsonl");
    await writeFile(fallbackPath, "{}\n");
    const router = createRouterHarness(true);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath: join(dir, "missing-session.jsonl") });
    registerAnalysisRoutes(router.ctx as never);

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
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath: join(dir, "hook-session.jsonl") });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
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
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath: join(dir, "hook-session.jsonl") });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
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

  it("serves stored artifact HTML with a permissive CSP and clears it from process memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-artifact-route-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let emit: ((event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: string } }) => void) | undefined;
    const dispose = vi.fn(async () => undefined);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    const html = "<main>Artifact<script>globalThis.__artifactRan = true</script></main>";
    emit?.({ type: "artifact", artifact: { id: "artifact/id", title: "Artifact", html, createdAt: new Date(0).toISOString() } });

    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid?theme=carbon&canvas=oklch%2833%25%200.006%20252%29&foreground=oklch%2895%25%200.003%20250%29&surface=%2318202b&hairline=%2335404d&accent=%2365d1ff&muted=%2396a0ad");

    expect(response).toMatchObject({ status: 200, ended: true });
    expect(response.body).toContain('<html data-theme="carbon" style="background-color:oklch(33% 0.006 252)!important;background-image:none!important;color:oklch(95% 0.003 250)!important;min-height:100%!important;color-scheme:dark!important;">');
    expect(response.body).toContain(`<body style="background-color:oklch(33% 0.006 252)!important;background-image:none!important;color:oklch(95% 0.003 250)!important;min-height:100%!important;color-scheme:dark!important;margin:0!important;">${html}</body>`);
    expect(response.body).toContain("<script>globalThis.__artifactRan = true</script>");
    const fragmentDocument = new DOMParser().parseFromString(response.body, "text/html");
    const fragmentCss = artifactBaseCss({
      canvas: "oklch(33% 0.006 252)",
      surface: "#18202b",
      foreground: "oklch(95% 0.003 250)",
      muted: "#96a0ad",
      hairline: "#35404d",
      accent: "#65d1ff",
    });
    expect(fragmentDocument.documentElement.getAttribute("data-theme")).toBe("carbon");
    expect(response.body).toContain(`<head><style>${fragmentCss}</style></head><body`);
    expect(fragmentDocument.head.querySelector("style")?.textContent).toBe(fragmentCss);
    expect(fragmentDocument.body.querySelector("main")?.textContent).toBe("ArtifactglobalThis.__artifactRan = true");
    expect(response.headers).toMatchObject({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": ANALYSIS_ARTIFACT_CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    expect(response.headers["Content-Security-Policy"]).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(response.headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(response.headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    expect(response.headers["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
    expect(response.headers).not.toHaveProperty("Cross-Origin-Opener-Policy");
    expect(response.headers).not.toHaveProperty("Cross-Origin-Resource-Policy");

    const legacyResponse = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid?canvas=%23101010&foreground=%23efefef");
    const legacyDocument = new DOMParser().parseFromString(legacyResponse.body, "text/html");
    expect(legacyDocument.head.querySelector("style")?.textContent).toBe(artifactBaseCss({
      canvas: "#101010",
      surface: "#101010",
      foreground: "#efefef",
      muted: "#efefef",
      hairline: "#efefef",
      accent: "#efefef",
    }));

    emit?.({ type: "artifact", artifact: { id: "headless", title: "Headless", html: "<!doctype html><html lang=\"en\"><body><main>Headless</main></body></html>", createdAt: new Date(0).toISOString() } });
    const headlessResponse = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/headless?canvas=%23101010&foreground=%23efefef");
    const htmlStart = headlessResponse.body.indexOf("<html");
    const htmlStartEnd = headlessResponse.body.indexOf(">", htmlStart) + 1;
    expect(headlessResponse.body.slice(htmlStartEnd)).toMatch(/^<style>:root\{/);

    emit?.({ type: "artifact", artifact: { id: "decoy", title: "Decoy", html: "<!doctype html><html lang=\"en\"><template><head></head></template><body><main>Decoy</main></body></html>", createdAt: new Date(0).toISOString() } });
    const decoyResponse = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/decoy?canvas=%23101010&foreground=%23efefef");
    const decoyHtmlStart = decoyResponse.body.indexOf("<html");
    const decoyHtmlStartEnd = decoyResponse.body.indexOf(">", decoyHtmlStart) + 1;
    expect(decoyResponse.body.slice(decoyHtmlStartEnd)).toMatch(/^<style>:root\{/);
    const decoyDocument = new DOMParser().parseFromString(decoyResponse.body, "text/html");
    expect(decoyDocument.head.querySelector("style")?.textContent).toContain("--fleet-canvas:#101010");
    expect(decoyDocument.querySelector("template")?.innerHTML).not.toContain("--fleet-canvas");

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/stop", {});
    const afterStop = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid");
    expect(afterStop).toMatchObject({ status: 200, ended: true });
    expect(afterStop.body).toContain(html);
    expect(afterStop.body).toContain('<html data-theme="instrument" style="background-color:Canvas!important;');
    const defaultDocument = new DOMParser().parseFromString(afterStop.body, "text/html");
    expect(defaultDocument.head.querySelector("style")?.textContent).toBe(artifactBaseCss({
      canvas: "Canvas",
      surface: "Canvas",
      foreground: "CanvasText",
      muted: "CanvasText",
      hairline: "CanvasText",
      accent: "CanvasText",
    }));
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockClear();

    await router.call("DELETE", "/api/v1/plugins/terminal/analysis/op/artifacts");
    await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid");
    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { message: "Analysis artifact was not found." } } });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    emit?.({ type: "artifact", artifact: { id: "deleted-artifact", title: "Deleted artifact", html, createdAt: new Date(0).toISOString() } });
    router.emitOperationDeleted({ operationId: "op", pluginId: "terminal" });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/deleted-artifact");
    expect(router.responses.at(-1)).toMatchObject({ status: 200 });
    router.emitOperationPurged({ operationId: "op", pluginId: "terminal" });
    await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/deleted-artifact");
    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { message: "Analysis artifact was not found." } } });
  });

  it("wraps hostile artifact CSS with a validated host-owned canvas for every Console theme", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-artifact-theme-route-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let emit: ((event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: string } }) => void) | undefined;
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    const hostileHtml = `<!doctype html><html lang="en" class='artifact-root' data-note="quoted > value" data-theme="artifact" style='scrollbar-gutter:stable;background-color:white!important'><head><style>html,body{background:linear-gradient(white,white)!important;color:white!important;min-height:1px!important;color-scheme:light!important}</style></head><body class="artifact-body" aria-label='Artifact > body' data-layout="report" style='display:grid;padding:24px;font-family:"Artifact Serif";--artifact-label:"alpha;beta";letter-spacing:.1em;margin:40px;background-color:hotpink!important;background-image:linear-gradient(white,white)!important;color:white!important;min-height:1px!important;color-scheme:light!important'><script>globalThis.__artifactRan=true</script><main>Artifact</main></body></html>`;
    emit?.({ type: "artifact", artifact: { id: "hostile", title: "Hostile", html: hostileHtml, createdAt: new Date(0).toISOString() } });

    for (const theme of ["instrument", "maritime", "carbon", "whites"] as const) {
      const path = `/api/v1/plugins/terminal/analysis/artifacts/hostile?theme=${theme}&canvas=${encodeURIComponent("#123456")}&foreground=${encodeURIComponent("#f0f0f0")}&surface=${encodeURIComponent("#18202b")}&hairline=${encodeURIComponent("#35404d")}&accent=${encodeURIComponent("#65d1ff")}&muted=${encodeURIComponent("#96a0ad")}`;
      const response = await router.call("GET", path);
      const expectedColorScheme = theme === "whites" ? "light" : "dark";
      expect(response.status).toBe(200);
      const document = new DOMParser().parseFromString(response.body, "text/html");
      const headStyles = document.head.querySelectorAll("style");
      expect(headStyles).toHaveLength(2);
      expect(document.head.firstElementChild).toBe(headStyles[0]);
      expect(headStyles[0]?.textContent).toBe(artifactBaseCss({
        canvas: "#123456",
        surface: "#18202b",
        foreground: "#f0f0f0",
        muted: "#96a0ad",
        hairline: "#35404d",
        accent: "#65d1ff",
      }));
      expect(headStyles[0]?.textContent).not.toContain("!important");
      expect(headStyles[1]?.textContent).toContain("background:linear-gradient(white,white)!important");
      expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
      expect(document.documentElement).toMatchObject({ lang: "en", className: "artifact-root" });
      expect(document.documentElement.getAttribute("data-note")).toBe("quoted > value");
      expect(document.body).toMatchObject({ className: "artifact-body" });
      expect(document.body.getAttribute("aria-label")).toBe("Artifact > body");
      expect(document.body.getAttribute("data-layout")).toBe("report");
      expect(document.documentElement.style.scrollbarGutter).toBe("stable");
      expect(document.body.style.display).toBe("grid");
      expect(document.body.style.padding).toBe("24px");
      expect(document.body.style.fontFamily).toBe('"Artifact Serif"');
      expect(document.body.style.getPropertyValue("--artifact-label")).toBe('"alpha;beta"');
      expect(document.body.style.letterSpacing).toBe("0.1em");
      expect(document.documentElement.style.getPropertyValue("background-color")).toBe("rgb(18, 52, 86)");
      expect(document.body.style.getPropertyValue("background-color")).toBe("rgb(18, 52, 86)");
      expect(document.body.style.getPropertyValue("background-image")).toBe("none");
      expect(document.body.style.getPropertyValue("color")).toBe("rgb(240, 240, 240)");
      expect(document.body.style.getPropertyValue("min-height")).toBe("100%");
      expect(document.body.style.getPropertyValue("color-scheme")).toBe(expectedColorScheme);
      if (theme === "whites") expect(response.body).toContain("color-scheme:light!important");
      expect(document.body.style.getPropertyValue("margin")).toBe("0px");
      for (const property of ["background-color", "background-image", "color", "min-height", "color-scheme", "margin"]) {
        expect(document.body.style.getPropertyPriority(property)).toBe("important");
      }
      expect(document.querySelector("script")?.textContent).toContain("globalThis.__artifactRan=true");
      expect(response.body.match(/<html\b/gi)).toHaveLength(1);
      expect(response.body.match(/<body\b/gi)).toHaveLength(1);
    }
  });

  it("falls back instead of embedding hostile, invalid, or overlong theme canvas inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-artifact-input-route-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let emit: ((event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: string } }) => void) | undefined;
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    emit?.({ type: "artifact", artifact: { id: "safe", title: "Safe", html: "<p>safe</p>", createdAt: new Date(0).toISOString() } });
    const hostile = 'red!important;"><script>globalThis.injected=true</script>';
    const query = new URLSearchParams({
      theme: 'carbon" onload="alert(1)',
      canvas: hostile,
      foreground: "x".repeat(101),
      surface: '#fff";--injected-surface:red',
      hairline: "rgb(1 2 3);color:red",
      accent: "url(javascript:alert(1))",
      muted: "oklch(50% 0 0);}</style><script>globalThis.mutedInjected=true</script>",
    });
    const path = `/api/v1/plugins/terminal/analysis/artifacts/safe?${query.toString()}`;

    const response = await router.call("GET", path);

    expect(response.status).toBe(200);
    const document = new DOMParser().parseFromString(response.body, "text/html");
    expect(document.documentElement.getAttribute("data-theme")).toBe("instrument");
    expect(document.documentElement.style.getPropertyValue("background-color")).toBe("canvas");
    expect(document.documentElement.style.getPropertyValue("color")).toBe("canvastext");
    expect(document.head.querySelector("style")?.textContent).toBe(artifactBaseCss({
      canvas: "Canvas",
      surface: "Canvas",
      foreground: "CanvasText",
      muted: "CanvasText",
      hairline: "CanvasText",
      accent: "CanvasText",
    }));
    expect(response.body).not.toContain("globalThis.injected");
    expect(response.body).not.toContain("mutedInjected");
    expect(response.body).not.toContain("injected-surface");
    expect(response.body).not.toContain("javascript:alert");
    expect(document.documentElement.hasAttribute("onload")).toBe(false);
  });

  it("host-gates artifact documents and returns 404 for unknown ids", async () => {
    const router = createRouterHarness(false);
    registerAnalysisRoutes(router.ctx as never);

    await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/missing");
    expect(router.responses.at(-1)).toMatchObject({ status: 403 });

    router.allowHost = true;
    await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/missing");
    expect(router.responses.at(-1)).toMatchObject({ status: 404 });
  });

  it("validates Host before route work and never reveals unavailable capture paths", async () => {
    const router = createRouterHarness(false);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now" });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-a", models: [{ modelId: "model-a", name: "Model A", effort: { supported: true, levels: ["low"], default: "low" } }] }) as never,
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
    registerAnalysisRoutes(router.ctx as never, { detect 
    });
    const requests = [
      ["GET", "/api/v1/plugins/terminal/analysis/catalog"],
      ["GET", "/api/v1/plugins/terminal/analysis/stream"],
      ["GET", "/api/v1/plugins/terminal/analysis/op/ready"],
      ["POST", "/api/v1/plugins/terminal/analysis/op/start"],
      ["POST", "/api/v1/plugins/terminal/analysis/op/message"],
      ["GET", "/api/v1/plugins/terminal/analysis/op/stream"],
      ["POST", "/api/v1/plugins/terminal/analysis/op/stop"],
      ["GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact"],
      ["DELETE", "/api/v1/plugins/terminal/analysis/op/artifacts"],
    ] as const;

    for (const [method, pathname] of requests) {
      await router.call(method, pathname, {}, { origin: "https://evil.example" });
    }

    expect(router.responses).toHaveLength(requests.length);
    expect(router.responses).toEqual(requests.map(() => ({ status: 403, body: { error: { code: "analysis_catalog_invalid", message: "Analysis request is not accepted by this host." } } })));
    expect(detect).not.toHaveBeenCalled();
  });

  it("routes registry publications through subscribeAll with operation isolation", async () => {
    const registry = new AnalysisRegistry();
    const received: Array<{ operationId: string; event: unknown }> = [];
    const unsubscribe = registry.subscribeAll((operationId, event) => { received.push({ operationId, event }); });
    const sessions = ["op-a", "op-b"].map((operationId) => {
      let emit: ((event: AnalysisEvent) => void) | undefined;
      return { operationId, emitRef: () => emit, start: registry.start(operationId, (onEvent) => { emit = onEvent; return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined } as never; }) };
    });
    await Promise.all(sessions.map((session) => session.start));
    sessions[0]!.emitRef()?.({ type: "chunk", text: "alpha" });
    sessions[1]!.emitRef()?.({ type: "chunk", text: "beta" });
    expect(received).toEqual([
      { operationId: "op-a", event: { type: "chunk", text: "alpha" } },
      { operationId: "op-b", event: { type: "chunk", text: "beta" } },
    ]);
    unsubscribe();
    await registry.dispose();
  });

  it("lists active operation ids in deterministic code-unit lexicographic order", async () => {
    const registry = new AnalysisRegistry();
    for (const operationId of ["op-z", "op2", "op10", "Op-a"]) {
      await registry.start(operationId, () => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }) as never);
    }
    expect(registry.activeOperationIds()).toEqual(["Op-a", "op-z", "op10", "op2"]);
    expect(registry.activeOperationIds()).not.toEqual(["Op-a", "op-z", "op2", "op10"]);
    await registry.dispose();
  });

  it("writes a sorted connected roster and operation-isolated global event envelopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-global-stream-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const emitters = new Map<string, (event: AnalysisEvent) => void>();
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: ((options: { onEvent: (event: AnalysisEvent) => void; capturePath?: string }) => {
        emitters.set(options.capturePath ?? "default", options.onEvent);
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/stream");
    expect(response.writes[0]).toBe(`data: ${JSON.stringify({ type: "connected", operationIds: ["op"] })}\n\n`);
    emitters.values().next().value?.({ type: "chunk", text: "isolated" });
    await vi.waitFor(() => expect(response.writes.at(-1)).toBe(`data: ${JSON.stringify({ type: "event", operationId: "op", event: { type: "chunk", text: "isolated" } })}\n\n`));
  });

  it("excludes pending starts from activeOperationIds until session.start settles", async () => {
    const registry = new AnalysisRegistry();
    let resolveStart!: () => void;
    const pending = registry.start("op-pending", () => ({
      start: () => new Promise<void>((resolve) => { resolveStart = resolve; }),
      send: async () => undefined,
      dispose: async () => undefined,
    }) as never);
    expect(registry.activeOperationIds()).toEqual([]);
    resolveStart();
    await pending;
    expect(registry.activeOperationIds()).toEqual(["op-pending"]);
    await registry.dispose();
  });

  it("removes failed starts from activeOperationIds snapshots", async () => {
    const registry = new AnalysisRegistry();
    await expect(registry.start("op-fail", () => ({
      start: async () => { throw new Error("start failed"); },
      send: async () => undefined,
      dispose: async () => undefined,
    }) as never)).rejects.toThrow("start failed");
    expect(registry.activeOperationIds()).toEqual([]);
  });

  it("publishes roster add and remove updates to global stream subscribers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-global-roster-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: () => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }) as never,
    });
    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/stream");
    expect(response.writes[0]).toBe(`data: ${JSON.stringify({ type: "connected", operationIds: [] })}\n\n`);
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    await vi.waitFor(() => expect(response.writes.at(-1)).toBe(`data: ${JSON.stringify({ type: "connected", operationIds: ["op"] })}\n\n`));
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/stop", {});
    await vi.waitFor(() => expect(response.writes.at(-1)).toBe(`data: ${JSON.stringify({ type: "connected", operationIds: [] })}\n\n`));
  });

  it("routes generic send rejection through the global event envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-global-error-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: () => ({
        start: async () => undefined,
        send: async () => { throw new Error("/Users/alice/private token"); },
        dispose: async () => undefined,
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/stream");
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/message", { text: "review" });
    await vi.waitFor(() => expect(response.writes.at(-1)).toBe(`data: ${JSON.stringify({
      type: "event",
      operationId: "op",
      event: { type: "error", error: { code: "analysis_error", message: "Analysis request failed." } },
    })}\n\n`));
    expect(JSON.stringify(response.writes)).not.toContain("/Users/alice/private");
  });

  it("routes analysis_exited through the global event envelope before cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-global-exited-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let emit: ((event: AnalysisEvent) => void) | undefined;
    const dispose = vi.fn(async () => undefined);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/stream");
    emit?.({ type: "error", error: { code: "analysis_exited", message: "exited" } });
    const eventWrite = `data: ${JSON.stringify({
      type: "event",
      operationId: "op",
      event: { type: "error", error: { code: "analysis_exited", message: "exited" } },
    })}\n\n`;
    await vi.waitFor(() => expect(response.writes).toContain(eventWrite));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it("publishes analysis_exited through subscribeAll before the session is released", async () => {
    const registry = new AnalysisRegistry();
    const received: unknown[] = [];
    registry.subscribeAll((_operationId, event) => { received.push(event); });
    let emit: ((event: AnalysisEvent) => void) | undefined;
    const dispose = vi.fn(async () => undefined);
    await registry.start("op", (onEvent) => {
      emit = onEvent;
      return { start: async () => undefined, send: async () => undefined, dispose } as never;
    });
    emit?.({ type: "error", error: { code: "analysis_exited", message: "exited" } });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(received).toEqual([{ type: "error", error: { code: "analysis_exited", message: "exited" } }]);
    await expect(registry.message("op", "hello")).resolves.toBe("not_found");
  });
});

function createRouterHarness(initialHostAllowance: boolean) {
  let handler: ((context: { req: EventEmitter & { method: string; headers: Record<string, string>; socket: { localPort: number } }; res: EventEmitter; pathname: string }) => Promise<boolean>) | undefined;
  const operationLifecycleHandlers = new Map<string, (payload: unknown) => void>();
  const responses: Array<{ status: number; body: unknown }> = [];
  const operation = { id: "op", pluginId: "terminal", type: "agent", theaterId: "theater", payload: {} as Record<string, unknown>, ts: { createdAt: 0, updatedAt: 0 } };
  const state = { allowHost: initialHostAllowance, operationPresent: true, operation };
  const ctx = {
    pluginId: "terminal", basePath: "/api/v1/plugins/terminal",
    registerRouter: (_path: string, registered: typeof handler) => { handler = registered; },
    host: {
      security: {
        validateHost: () => state.allowHost,
        isTerminalAuthorized: (req: { headers: Record<string, string> }) => req.headers.origin !== "https://evil.example",
      },
      http: { writeJson: (_res: EventEmitter, status: number, body: unknown) => responses.push({ status, body }), readJsonBody: async (req: EventEmitter & { body?: unknown }) => req.body ?? null },
      operations: { get: (id: string) => state.operationPresent && id === "op" ? state.operation : null },
      paths: { resolveTheaterPath: () => "/theater" },
      events: {
        subscribe: (channel: string, subscriber: (payload: unknown) => void) => {
          operationLifecycleHandlers.set(channel, subscriber);
          return () => { operationLifecycleHandlers.delete(channel); };
        },
      },
      lifecycle: { registerCleanup: () => () => undefined },
    },
  };
  return {
    ctx, operation: state.operation, responses,
    get allowHost() { return state.allowHost; }, set allowHost(value: boolean) { state.allowHost = value; },
    setProviderSession(providerSession: { readonly provider: "claude" | "codex"; readonly sessionId: string; readonly capturedAt: string; readonly transcriptPath?: string; readonly source?: string }) {
      state.operation.payload = { ...state.operation.payload, providerSession };
    },
    deleteOperation() { state.operationPresent = false; },
    recreateOperation() {
      state.operation = { ...operation, theaterId: "replacement-theater", ts: { createdAt: 1, updatedAt: 1 } };
      state.operationPresent = true;
    },
    emitOperationDeleted(payload: unknown) { operationLifecycleHandlers.get("operation:deleted")?.(payload); },
    emitOperationPurged(payload: unknown) { operationLifecycleHandlers.get("operation:purged")?.(payload); },
    async call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
      const writes: string[] = [];
      let ended = false;
      let responseStatus: number | undefined;
      let responseHeaders: Record<string, string> = {};
      let responseBody = "";
      const url = new URL(pathname, "http://fleet.test");
      const req = Object.assign(new EventEmitter(), { method, url: `${url.pathname}${url.search}`, headers: { "content-type": "application/json", ...headers }, socket: { localPort: 4444 }, body });
      const res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        writeHead: (status: number, responseHead: Record<string, string> = {}) => { responseStatus = status; responseHeaders = responseHead; },
        write: (data: string) => { writes.push(data); },
        end: (data?: string) => { if (data) responseBody += data; ended = true; },
      });
      await handler?.({ req, res, pathname: url.pathname });
      return { writes, get ended() { return ended; }, get status() { return responseStatus; }, get headers() { return responseHeaders; }, get body() { return responseBody; } };
    },
  };
}

type ArtifactEmitter = (event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: number } }) => void;

async function startArtifactSession(registry: AnalysisRegistry, operationId: string): Promise<ArtifactEmitter> {
  let emit: ArtifactEmitter | undefined;
  await registry.start(operationId, (onEvent) => {
    emit = onEvent as ArtifactEmitter;
    return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined } as never;
  });
  if (!emit) throw new Error("artifact emitter was not created");
  return emit;
}

function emitArtifact(emit: ArtifactEmitter, artifactId: string): void {
  emit({ type: "artifact", artifact: { id: artifactId, title: artifactId, html: `<p>${artifactId}</p>`, createdAt: 0 } });
}
