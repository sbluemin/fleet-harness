// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@dotobokuri/fleet-analyst", () => ({ AnalystSession: class {} }));

import { AnalysisRegistry, MAX_ANALYSIS_ARTIFACTS, MAX_STOPPED_ANALYSIS_ARTIFACTS } from "./analysis-registry.js";
import { ANALYSIS_ARTIFACT_CSP, registerAnalysisRoutes } from "./analysis-routes.js";
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

  it("serves stored artifact HTML with a permissive CSP and clears it from process memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-artifact-route-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let emit: ((event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: string } }) => void) | undefined;
    const dispose = vi.fn(async () => undefined);
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath }),
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    const html = "<main>Artifact<script>globalThis.__artifactRan = true</script></main>";
    emit?.({ type: "artifact", artifact: { id: "artifact/id", title: "Artifact", html, createdAt: new Date(0).toISOString() } });

    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid?theme=carbon&canvas=oklch%2833%25%200.006%20252%29&foreground=oklch%2895%25%200.003%20250%29");

    expect(response).toMatchObject({ status: 200, ended: true });
    expect(response.body).toContain('<html data-theme="carbon" style="background-color:oklch(33% 0.006 252)!important;background-image:none!important;color:oklch(95% 0.003 250)!important;min-height:100%!important;color-scheme:dark!important;">');
    expect(response.body).toContain(`<body style="background-color:oklch(33% 0.006 252)!important;background-image:none!important;color:oklch(95% 0.003 250)!important;min-height:100%!important;color-scheme:dark!important;margin:0!important;">${html}</body>`);
    expect(response.body).toContain("<script>globalThis.__artifactRan = true</script>");
    const fragmentDocument = new DOMParser().parseFromString(response.body, "text/html");
    expect(fragmentDocument.documentElement.getAttribute("data-theme")).toBe("carbon");
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

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/stop", {});
    const afterStop = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid");
    expect(afterStop).toMatchObject({ status: 200, ended: true });
    expect(afterStop.body).toContain(html);
    expect(afterStop.body).toContain('<html data-theme="instrument" style="background-color:Canvas!important;');
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
    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { message: "Analysis artifact was not found." } } });
  });

  it("wraps hostile artifact CSS with a validated host-owned canvas for every Console theme", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-artifact-theme-route-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    let emit: ((event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: string } }) => void) | undefined;
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath }),
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    const hostileHtml = `<!doctype html><html lang="en" class='artifact-root' data-note="quoted > value" data-theme="artifact" style='scrollbar-gutter:stable;background-color:white!important'><head><style>html,body{background:linear-gradient(white,white)!important;color:white!important;min-height:1px!important;color-scheme:light!important}</style></head><body class="artifact-body" aria-label='Artifact > body' data-layout="report" style='display:grid;padding:24px;font-family:"Artifact Serif";--artifact-label:"alpha;beta";letter-spacing:.1em;margin:40px;background-color:hotpink!important;background-image:linear-gradient(white,white)!important;color:white!important;min-height:1px!important;color-scheme:light!important'><script>globalThis.__artifactRan=true</script><main>Artifact</main></body></html>`;
    emit?.({ type: "artifact", artifact: { id: "hostile", title: "Hostile", html: hostileHtml, createdAt: new Date(0).toISOString() } });

    for (const theme of ["instrument", "maritime", "carbon"] as const) {
      const path = `/api/v1/plugins/terminal/analysis/artifacts/hostile?theme=${theme}&canvas=${encodeURIComponent("#123456")}&foreground=${encodeURIComponent("#f0f0f0")}`;
      const response = await router.call("GET", path);
      expect(response.status).toBe(200);
      const document = new DOMParser().parseFromString(response.body, "text/html");
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
      expect(document.body.style.getPropertyValue("color-scheme")).toBe("dark");
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
    registerAnalysisRoutes(router.ctx as never, {
      detect: async () => [{ id: "claude", displayName: "Claude Code", available: true, version: null }],
      modelsFor: () => ({ defaultModel: "model-b", models: [{ modelId: "model-b", name: "Model B", effort: { supported: false } }] }) as never,
      readCapture: () => ({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath }),
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "model-b" });
    emit?.({ type: "artifact", artifact: { id: "safe", title: "Safe", html: "<p>safe</p>", createdAt: new Date(0).toISOString() } });
    const hostile = 'red!important;"><script>globalThis.injected=true</script>';
    const path = `/api/v1/plugins/terminal/analysis/artifacts/safe?theme=${encodeURIComponent('carbon" onload="alert(1)')}&canvas=${encodeURIComponent(hostile)}&foreground=${encodeURIComponent("x".repeat(101))}`;

    const response = await router.call("GET", path);

    expect(response.status).toBe(200);
    const document = new DOMParser().parseFromString(response.body, "text/html");
    expect(document.documentElement.getAttribute("data-theme")).toBe("instrument");
    expect(document.documentElement.style.getPropertyValue("background-color")).toBe("canvas");
    expect(document.documentElement.style.getPropertyValue("color")).toBe("canvastext");
    expect(response.body).not.toContain("globalThis.injected");
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
});

function createRouterHarness(initialHostAllowance: boolean) {
  let handler: ((context: { req: EventEmitter & { method: string; headers: Record<string, string>; socket: { localPort: number } }; res: EventEmitter; pathname: string }) => Promise<boolean>) | undefined;
  let operationDeletedHandler: ((payload: unknown) => void) | undefined;
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
      events: { subscribe: (_channel: string, subscriber: (payload: unknown) => void) => { operationDeletedHandler = subscriber; return () => { operationDeletedHandler = undefined; }; } }, lifecycle: { registerCleanup: () => () => undefined },
    },
  };
  return {
    ctx, responses,
    get allowHost() { return state.allowHost; }, set allowHost(value: boolean) { state.allowHost = value; },
    emitOperationDeleted(payload: unknown) { operationDeletedHandler?.(payload); },
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
