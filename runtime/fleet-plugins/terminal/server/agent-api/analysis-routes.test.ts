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
// 이 스위트는 게이트웨이 카탈로그·런타임을 jsdom 수집에 끌어오지 않는다. 여기서 쓰는 세 표면만 세운다.
vi.mock("@dotobokuri/core-ai-gateway", () => ({
  AI_GATEWAY_ROUTE_SEGMENT: "ai-gateway",
  resolveAiGatewaySelection: () => ({ models: [] }),
  toClaudeGatewayModelId: (model: { id: string }) => `claude-gateway--${model.id}`,
}));

import { ANALYSIS_ERROR_CODES, buildAnalysisCatalog, isAnalysisSelection, isMessageBody, type AnalysisEvent } from "./analysis-types.js";
import { readProviderSession } from "./provider-session.js";

/**
 * 라우트 테스트가 쓰는 네이티브 별칭 로스터.
 *
 * 실제 native 별칭 로스터를 그대로 흘려보내면 이 스위트가 fleet-admiral의
 * models.json 내용에 묶인다 — 거기서 한 모델의 강도 사다리만 바뀌어도 분석가와 무관한 이유로
 * 여기가 깨진다. 강도를 지원하는 것과 아닌 것을 하나씩 둬서 두 갈래를 다 덮는다.
 */
const ANALYST_NATIVE_MODELS = [
  { modelId: "sonnet", name: "Claude Sonnet", effort: { supported: true, levels: ["low", "high"], default: "medium" } },
  { modelId: "fixed-effort", name: "Fixed Effort", effort: { supported: false } },
] as const;

/** 카탈로그가 받아들이는 선택. 강도를 지원하는 모델은 강도 없이 시작할 수 없다. */
const START_SELECTION = { cliId: "claude", model: "sonnet", effort: "low" } as const;

type AnalysisRouteDeps = NonNullable<Parameters<typeof registerAnalysisRoutes>[1]>;

function registerAnalysis(router: { readonly ctx: unknown }, deps: Partial<AnalysisRouteDeps> = {}): void {
  registerAnalysisRoutes(router.ctx as never, {
    nativeModels: (() => [...ANALYST_NATIVE_MODELS]) as never,
    ...deps,
  });
}

function artifactTokens(colors: { readonly canvas: string; readonly surface: string; readonly foreground: string; readonly muted: string; readonly hairline: string; readonly accent: string; readonly inset?: string; readonly faint?: string; readonly hairlineStrong?: string; readonly positive?: string; readonly warn?: string; readonly critical?: string; readonly focus?: string }): string {
  // v2 파생 폴백 — 레거시(canvas/surface) URL은 ground/card로 흡수되고 새 티어는 단계 폴백한다.
  const inset = colors.inset ?? colors.canvas;
  const faint = colors.faint ?? colors.muted;
  const hairlineStrong = colors.hairlineStrong ?? colors.hairline;
  const positive = colors.positive ?? colors.foreground;
  const warn = colors.warn ?? colors.foreground;
  const critical = colors.critical ?? colors.foreground;
  const focus = colors.focus ?? colors.accent;
  return `:root{--fleet-canvas:${colors.canvas};--fleet-surface:${colors.surface};--fleet-card:${colors.surface};--fleet-inset:${inset};--fleet-ink:${colors.foreground};--fleet-muted:${colors.muted};--fleet-faint:${faint};--fleet-hairline:${colors.hairline};--fleet-hairline-strong:${hairlineStrong};--fleet-accent:${colors.accent};--fleet-positive:${positive};--fleet-warn:${warn};--fleet-critical:${critical};--fleet-focus:${focus};--fleet-sans:`;
}

const ARTIFACT_META_CSP = `<meta http-equiv="Content-Security-Policy" content="${ANALYSIS_ARTIFACT_CSP.split("; ").filter((directive) => !directive.startsWith("sandbox") && !directive.startsWith("frame-ancestors")).join("; ")}">`;

describe("Session Analyst server contract", () => {
  it("serializes all Console theme coordinates into artifact URLs", () => {
    const url = new URL(analysisArtifactUrl("artifact/id", "carbon", { ground: "#101820", foreground: "#f2f4f7", card: "#18212b", inset: "#0c1014", hairline: "#35404d", hairlineStrong: "#4a5764", accent: "#65d1ff", muted: "#96a0ad", faint: "#7d8894", positive: "#5fd39a", warn: "#e5c07b", critical: "#f2777a", focus: "#d9a441", sansFont: "/console/assets/manrope-latin.woff2", monoFont: "/console/assets/jetbrains-latin.woff2", sansCjkSheets: ["/console/assets/pretendard.css"], monoCjkSheets: ["/console/assets/korean-400.css", "/console/assets/korean-700.css"] }), "http://fleet.invalid");

    expect(url.pathname).toBe("/plugins/terminal/analysis/artifacts/artifact%2Fid");
    // 한글 시트는 굵기별로 여러 장이라 같은 키를 반복한다 — 서버는 getAll로 읽는다.
    expect(url.searchParams.getAll("sansCjkSheet")).toEqual(["/console/assets/pretendard.css"]);
    expect(url.searchParams.getAll("monoCjkSheet")).toEqual(["/console/assets/korean-400.css", "/console/assets/korean-700.css"]);
    url.searchParams.delete("sansCjkSheet");
    url.searchParams.delete("monoCjkSheet");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      theme: "carbon",
      ground: "#101820",
      foreground: "#f2f4f7",
      card: "#18212b",
      inset: "#0c1014",
      hairline: "#35404d",
      hairlineStrong: "#4a5764",
      accent: "#65d1ff",
      muted: "#96a0ad",
      faint: "#7d8894",
      positive: "#5fd39a",
      warn: "#e5c07b",
      critical: "#f2777a",
      focus: "#d9a441",
      sansFont: "/console/assets/manrope-latin.woff2",
      monoFont: "/console/assets/jetbrains-latin.woff2",
    });
  });

  it("offers native aliases beside the enabled gateway models and rejects stale selections", () => {
    const native = [
      { modelId: "sonnet", name: "Claude Sonnet", effort: { supported: true, levels: ["low", "high"], default: "medium" } },
      { modelId: "opus", name: "Claude Opus", effort: { supported: true, levels: ["low", "high"], default: "xhigh" } },
    ];
    // 카탈로그 내용이 아니라 두 갈래가 한 목록으로 합쳐지는지를 본다. 실제 카탈로그를 import하면
    // 이 스위트가 core-ai-gateway 전체를 번들하려다 수집 단계에서 죽는다.
    const gateway = [{
      id: "codex--gpt-5.6-luna-fast",
      displayName: "GPT-5.6-Luna-Fast",
      provider: "codex",
      effort: { supported: true, levels: ["low", "high"] },
    }] as unknown as Parameters<typeof buildAnalysisCatalog>[1];
    const catalog = buildAnalysisCatalog(native, gateway, true);
    const entry = catalog.clis[0]!;
    expect(catalog.clis.map((cli) => cli.cliId)).toEqual(["claude"]);
    expect(entry.available).toBe(true);
    // 소유자가 정한 기본은 sonnet/low다. 오늘의 기본이던 opus/xhigh를 낮춘 것이며,
    // 분석가 사다리는 low/medium/high만 연다 — xhigh는 기본값으로도, 선택지로도 서지 않는다.
    expect(entry.defaultModel).toBe("sonnet");
    expect(entry.models.find((model) => model.id === "sonnet")?.defaultEffort).toBe("low");
    expect(entry.models.find((model) => model.id === "sonnet")?.effortLevels).toEqual(["low", "high"]);
    expect(entry.models.find((model) => model.id === "opus")?.defaultEffort).toBe("low");
    expect(entry.models.find((model) => model.id === "opus")?.effortLevels).toEqual(["low", "high"]);
    expect(JSON.stringify(entry.models)).not.toMatch(/xhigh|max|ultra/);
    expect(entry.models.some((model) => model.id.startsWith("claude-gateway--"))).toBe(true);
    // 게이트웨이 모델 스키마에는 기본 강도가 없으므로 지어내지 않는다.
    expect(entry.models.find((model) => model.id.startsWith("claude-gateway--"))).not.toHaveProperty("defaultEffort");
    expect(JSON.stringify(catalog)).not.toMatch(/path|version|session/i);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "sonnet", effort: "low" })).toBe(true);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "sonnet", effort: "low", language: "ko" })).toBe(true);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "sonnet", effort: "low", language: "ja" })).toBe(false);
    // 강도를 지원하는 모델은 강도 없이 시작할 수 없다.
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "sonnet" })).toBe(false);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "removed", effort: "low" })).toBe(false);

    // 반대로 강도가 없는 모델은 강도를 실으면 거부한다 — 사용자가 고르지 않은 값이기 때문이다.
    const noEffortCatalog = buildAnalysisCatalog([{ modelId: "model-b", name: "Model B", effort: { supported: false } }], [], true);
    expect(isAnalysisSelection(noEffortCatalog, { cliId: "claude", model: "model-b" })).toBe(true);
    expect(isAnalysisSelection(noEffortCatalog, { cliId: "claude", model: "model-b", effort: "" })).toBe(true);
    expect(isAnalysisSelection(noEffortCatalog, { cliId: "claude", model: "model-b", effort: "low" })).toBe(false);
  });

  it("reports the analyst unavailable before the Console is listening", () => {
    // 포트를 추측해 자식을 띄우면 첫 턴에서야 알 수 없는 이유로 죽는다.
    const native = [{ modelId: "sonnet", name: "Claude Sonnet", effort: { supported: true, levels: ["low"], default: "low" } }];
    expect(buildAnalysisCatalog(native, [], false).clis[0]!.available).toBe(false);
    expect(buildAnalysisCatalog([], [], true).clis[0]!.available).toBe(false);
  });

  it("clamps analyst effort rungs to low, medium, and high", () => {
    const catalog = buildAnalysisCatalog(
      [{ modelId: "sonnet", name: "Claude Sonnet", effort: { supported: true, levels: ["low", "medium", "high", "xhigh", "max"], default: "xhigh" } }],
      [{
        id: "codex--gpt-5.6-luna-fast",
        displayName: "GPT-5.6-Luna-Fast",
        provider: "codex",
        effort: { supported: true, levels: ["low", "medium", "high", "xhigh"] },
      }] as unknown as Parameters<typeof buildAnalysisCatalog>[1],
      true,
    );
    const sonnet = catalog.clis[0]!.models.find((model) => model.id === "sonnet")!;
    const gateway = catalog.clis[0]!.models.find((model) => model.id.startsWith("claude-gateway--"))!;
    expect(sonnet.effortLevels).toEqual(["low", "medium", "high"]);
    expect(sonnet.defaultEffort).toBe("low");
    expect(gateway.effortLevels).toEqual(["low", "medium", "high"]);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "sonnet", effort: "high" })).toBe(true);
    expect(isAnalysisSelection(catalog, { cliId: "claude", model: "sonnet", effort: "xhigh" })).toBe(false);
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
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "fixed-effort", language: "ko" });
    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined, language: "ko" }));
  });

  it("binds the session to this Console's own gateway and carries nothing about an Agent CLI", async () => {
    // 예전에는 저장된 Agent CLI 경로와 정제된 env를 실어 자식을 직접 띄웠다. 이제 자식은 SDK가
    // 띄우고 이 라우트가 정하는 것은 어느 게이트웨이로 말할지뿐이므로, 경로·env가 다시 새어
    // 들어가면 여기서 걸린다.
    const dir = await mkdtemp(join(tmpdir(), "analysis-session-wiring-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn((_options: Record<string, unknown>) => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysis(router, { createSession: createSession as never });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);

    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    const options = createSession.mock.calls[0]?.[0] ?? {};
    expect(options).toMatchObject({
      // 포트를 추측하지 않는다 — 호스트가 실제로 리슨 중인 origin 아래 이 플러그인의 게이트웨이다.
      baseUrl: "http://127.0.0.1:43210/plugins/terminal/ai-gateway",
      model: "sonnet",
      effort: "low",
      cwd: "/theater",
      capturePath: transcriptPath,
    });
    expect(Object.keys(options).filter((key) => /cli|path|env/i.test(key))).toEqual(["capturePath"]);
  });

  it("refuses to start before the Console is listening instead of guessing a gateway port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-no-origin-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    router.setOrigin(null);
    registerAnalysis(router, { createSession: createSession as never });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);

    // 리슨 전이면 카탈로그가 이미 unavailable이므로 선택 자체가 서지 않는다.
    expect(router.responses.at(-1)).toMatchObject({ status: 400, body: { error: { code: "analysis_catalog_invalid" } } });
    expect(createSession).not.toHaveBeenCalled();
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
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    // 삭제 이벤트가 오지 않은 채 Operation만 사라지는 경로다. deletionMarker는 서지 않으므로
    // 마지막 확인의 나머지 절반 — 준비가 끝난 시점에 Operation이 아직 있는가 — 만이 이것을 잡는다.
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    const preparing = router.holdNextBodyRead();
    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
    await preparing.entered;
    router.deleteOperation();
    preparing.release();
    await starting;

    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { code: "analysis_session_not_found" } } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not register a session when its Operation is deleted and recreated with the same id during start preparation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-same-id-recreation-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    // CLI 탐지가 사라져 그 자리의 hold point도 사라졌다. 준비 단계를 붙잡아 같은 경합을 만든다 —
    // 같은 id로 다시 생긴 Operation은 별개이므로, 최종 확인은 id 존재가 아니라 삭제 사실을 봐야 한다.
    const createSession = vi.fn(() => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }));
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    const preparing = router.holdNextBodyRead();
    const starting = router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
    await preparing.entered;
    router.deleteOperation();
    router.emitOperationDeleted({ operationId: "op", pluginId: "terminal", type: "agent" });
    router.recreateOperation();
    preparing.release();
    await starting;

    expect(router.responses.at(-1)).toMatchObject({ status: 404, body: { error: { code: "analysis_session_not_found" } } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reports analysis as not ready when no provider capture exists", async () => {
    const router = createRouterHarness(true);
    registerAnalysis(router);

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");

    expect(router.responses.at(-1)).toEqual({ status: 200, body: { ready: false } });
  });

  it("reports analysis as ready when the captured transcript exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-ready-"));
    const transcriptPath = join(dir, "captured.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const router = createRouterHarness(true);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysis(router);

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
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    await router.call("GET", "/api/v1/plugins/terminal/analysis/op/ready");
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);

    expect(router.responses.at(-2)).toEqual({ status: 200, body: { ready: true } });
    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ capturePath: transcriptPath }));
    expect(readProviderSession(router.operation.payload)).toMatchObject({ harness: "claude-code", id: "legacy-private" });
  });

  it("reports analysis as ready when transcript fallback resolution succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-ready-fallback-"));
    const fallbackPath = join(dir, "active-session.jsonl");
    await writeFile(fallbackPath, "{}\n");
    const router = createRouterHarness(true);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath: join(dir, "missing-session.jsonl") });
    registerAnalysis(router);

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
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    registerAnalysis(router, {
      createSession: createSession as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
    expect(router.responses.at(-1)).toMatchObject({ status: 200, body: { started: true } });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ capturePath: activePath }));
  });

  it("writes connected and frozen error envelopes for a missing-session stream", async () => {
    const router = createRouterHarness(true);
    registerAnalysis(router);

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
    registerAnalysis(router, {
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
    const html = "<main>Artifact<script>globalThis.__artifactRan = true</script></main>";
    emit?.({ type: "artifact", artifact: { id: "artifact/id", title: "Artifact", html, createdAt: new Date(0).toISOString() } });

    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid?theme=carbon&canvas=oklch%2833%25%200.006%20252%29&foreground=oklch%2895%25%200.003%20250%29&surface=%2318202b&hairline=%2335404d&accent=%2365d1ff&muted=%2396a0ad");

    expect(response).toMatchObject({ status: 200, ended: true });
    expect(response.body).toContain('<html data-theme="carbon" style="background-color:oklch(33% 0.006 252)!important;background-image:none!important;color:oklch(95% 0.003 250)!important;min-height:100%!important;color-scheme:dark!important;">');
    expect(response.body).toContain(`<body style="background-color:oklch(33% 0.006 252)!important;background-image:none!important;color:oklch(95% 0.003 250)!important;min-height:100%!important;color-scheme:dark!important;margin:0!important;">${html}</body>`);
    expect(response.body).toContain("<script>globalThis.__artifactRan = true</script>");
    const fragmentDocument = new DOMParser().parseFromString(response.body, "text/html");
    const fragmentCss = artifactTokens({
      canvas: "oklch(33% 0.006 252)",
      surface: "#18202b",
      foreground: "oklch(95% 0.003 250)",
      muted: "#96a0ad",
      hairline: "#35404d",
      accent: "#65d1ff",
    });
    expect(fragmentDocument.documentElement.getAttribute("data-theme")).toBe("carbon");
    expect(response.body).toContain(`<head>${ARTIFACT_META_CSP}<style>${fragmentCss}`);
    expect(fragmentDocument.head.querySelector("style")?.textContent).toContain(fragmentCss);
    // 조판 바닥은 계약이다 — 모델이 스타일을 한 줄도 주지 않아도 아티팩트는 읽혀야 한다.
    const fragmentStyle = fragmentDocument.head.querySelector("style")?.textContent ?? "";
    expect(fragmentStyle).toContain("cite{display:inline-block");
    expect(fragmentStyle).toContain(".fleet-scroll{overflow-x:auto");
    expect(fragmentStyle).toContain("font-variant-numeric:tabular-nums");
    expect(fragmentStyle).toContain("prefers-reduced-motion:reduce");
    // Console 테마는 OS 테마와 독립이다. 바닥이 prefers-color-scheme으로 갈라지면 반대 테마를 칠한다.
    expect(fragmentStyle).not.toContain("prefers-color-scheme");
    // 아티팩트는 바깥으로 신호를 내지 않는다 — 폰트든 스크립트든 원격 출처가 있으면 안 된다.
    expect(fragmentStyle).not.toContain("//");
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
    // 오프라인 보장은 프롬프트 권고가 아니라 샌드박스가 강제한다 — 원격 스킴이 하나도 없어야 한다.
    expect(response.headers["Content-Security-Policy"]).not.toContain("https:");
    expect(response.headers["Content-Security-Policy"]).not.toContain("http:");
    expect(response.headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    // form-action은 default-src로 폴백하지 않는다 — 헤더 sandbox가 없는 내려받은 사본에서 폼 제출이 남는다.
    expect(response.headers["Content-Security-Policy"]).toContain("form-action 'none'");
    expect(ARTIFACT_META_CSP).toContain("form-action 'none'");
    // 내려받은 사본에는 헤더가 따라가지 않으므로 같은 리소스 정책이 문서 안에도 실린다.
    expect(response.body).toContain(ARTIFACT_META_CSP);
    expect(ARTIFACT_META_CSP).not.toContain("sandbox");
    expect(response.headers).not.toHaveProperty("Cross-Origin-Opener-Policy");
    expect(response.headers).not.toHaveProperty("Cross-Origin-Resource-Policy");

    const legacyResponse = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid?canvas=%23101010&foreground=%23efefef");
    const legacyDocument = new DOMParser().parseFromString(legacyResponse.body, "text/html");
    expect(legacyDocument.head.querySelector("style")?.textContent).toContain(artifactTokens({
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
    expect(headlessResponse.body.slice(htmlStartEnd)).toMatch(/^<meta http-equiv="Content-Security-Policy"/);

    emit?.({ type: "artifact", artifact: { id: "decoy", title: "Decoy", html: "<!doctype html><html lang=\"en\"><template><head></head></template><body><main>Decoy</main></body></html>", createdAt: new Date(0).toISOString() } });
    const decoyResponse = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/decoy?canvas=%23101010&foreground=%23efefef");
    const decoyHtmlStart = decoyResponse.body.indexOf("<html");
    const decoyHtmlStartEnd = decoyResponse.body.indexOf(">", decoyHtmlStart) + 1;
    expect(decoyResponse.body.slice(decoyHtmlStartEnd)).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    const decoyDocument = new DOMParser().parseFromString(decoyResponse.body, "text/html");
    expect(decoyDocument.head.querySelector("style")?.textContent).toContain("--fleet-canvas:#101010");
    expect(decoyDocument.querySelector("template")?.innerHTML).not.toContain("--fleet-canvas");

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/stop", {});
    const afterStop = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/artifact%2Fid");
    expect(afterStop).toMatchObject({ status: 200, ended: true });
    expect(afterStop.body).toContain(html);
    expect(afterStop.body).toContain('<html data-theme="instrument" style="background-color:Canvas!important;');
    const defaultDocument = new DOMParser().parseFromString(afterStop.body, "text/html");
    expect(defaultDocument.head.querySelector("style")?.textContent).toContain(artifactTokens({
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

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    registerAnalysis(router, {
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
      expect(document.head.firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
      expect(document.head.firstElementChild?.nextElementSibling).toBe(headStyles[0]);
      expect(headStyles[0]?.textContent).toContain(artifactTokens({
        canvas: "#123456",
        surface: "#18202b",
        foreground: "#f0f0f0",
        muted: "#96a0ad",
        hairline: "#35404d",
        accent: "#65d1ff",
      }));
      expect(headStyles[0]?.textContent).toContain(".fleet-callout{position:relative;");
      expect(headStyles[0]?.textContent).toContain(".fleet-callout::before{content:\"\";position:absolute;");
      expect(headStyles[0]?.textContent).not.toContain(".fleet-callout{display:grid;");
      // 바닥 시트는 모델 스타일을 짓밟지 않는다 — !important는 사용자 모션 설정 존중에만 허용된다.
      const motionIndex = headStyles[0]?.textContent?.indexOf("@media (prefers-reduced-motion") ?? -1;
      expect(motionIndex).toBeGreaterThan(0);
      expect(headStyles[0]?.textContent?.slice(0, motionIndex)).not.toContain("!important");
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
    registerAnalysis(router, {
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    expect(document.head.querySelector("style")?.textContent).toContain(artifactTokens({
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

  it("links same-origin Hangul fallback sheets and seats their faces behind the Latin bridge", async () => {
    const router = createRouterHarness(true);
    const transcriptPath = join(await mkdtemp(join(tmpdir(), "analysis-artifact-fonts-")), "session.jsonl");
    await writeFile(transcriptPath, "{}\n");
    let emit: ((event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: string } }) => void) | undefined;
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysis(router, {
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
    emit?.({ type: "artifact", artifact: { id: "fonts", title: "Fonts", html: "<p>한글</p>", createdAt: new Date(0).toISOString() } });
    const query = new URLSearchParams({ theme: "carbon", ground: "#101820", foreground: "#f2f4f7", sansFont: "/console/assets/manrope-latin.woff2", monoFont: "/console/assets/jetbrains-latin.woff2" });
    query.append("sansCjkSheet", "/console/assets/pretendardvariable-dynamic-subset-DIMR61Pu.css");
    query.append("monoCjkSheet", "/console/assets/korean-400-BaAbCdEf.css");
    query.append("monoCjkSheet", "/console/assets/korean-700-BaAbCdEf.css");
    // 같은 경로의 중복은 한 번만, origin 밖·상위 경로·프로토콜 상대·비-CSS는 전부 버린다.
    query.append("monoCjkSheet", "/console/assets/korean-700-BaAbCdEf.css");
    query.append("monoCjkSheet", "https://fonts.example/evil.css");
    query.append("monoCjkSheet", "/console/assets/../secret.css");
    query.append("monoCjkSheet", "//fonts.example/evil.css");
    query.append("monoCjkSheet", "/console/assets/evil.js");
    query.append("sansCjkSheet", '/console/assets/x.css"><script>globalThis.sheetInjected=true</script><link href="');

    const response = await router.call("GET", `/api/v1/plugins/terminal/analysis/artifacts/fonts?${query.toString()}`);

    expect(response.status).toBe(200);
    const document = new DOMParser().parseFromString(response.body, "text/html");
    const links = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).map((link) => link.getAttribute("href"));
    expect(links).toEqual([
      "/console/assets/pretendardvariable-dynamic-subset-DIMR61Pu.css",
      "/console/assets/korean-400-BaAbCdEf.css",
      "/console/assets/korean-700-BaAbCdEf.css",
    ]);
    const style = document.head.querySelector("style")?.textContent ?? "";
    expect(style).toContain('--fleet-sans:"Fleet Console Sans","Pretendard Variable",ui-sans-serif');
    expect(style).toContain('--fleet-mono:"Fleet Console Mono","Nanum Gothic Coding",ui-monospace');
    expect(response.body).not.toContain("fonts.example");
    expect(response.body).not.toContain("secret.css");
    expect(response.body).not.toContain("evil.js");
    expect(response.body).not.toContain("sheetInjected");
  });

  it("keeps the system Hangul fallback when no sheet is bridged", async () => {
    const router = createRouterHarness(true);
    const transcriptPath = join(await mkdtemp(join(tmpdir(), "analysis-artifact-fonts-")), "session.jsonl");
    await writeFile(transcriptPath, "{}\n");
    let emit: ((event: { type: "artifact"; artifact: { id: string; title: string; html: string; createdAt: string } }) => void) | undefined;
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now", transcriptPath });
    registerAnalysis(router, {
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
    emit?.({ type: "artifact", artifact: { id: "plain", title: "Plain", html: "<p>plain</p>", createdAt: new Date(0).toISOString() } });

    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/plain?theme=carbon&ground=%23101820&foreground=%23f2f4f7");

    const document = new DOMParser().parseFromString(response.body, "text/html");
    expect(document.head.querySelector('link[rel="stylesheet"]')).toBeNull();
    const style = document.head.querySelector("style")?.textContent ?? "";
    expect(style).toContain('--fleet-sans:ui-sans-serif');
    expect(style).toContain('--fleet-mono:ui-monospace');
    expect(style).not.toContain("Pretendard");
    expect(style).not.toContain("Nanum");
  });

  it("host-gates artifact documents and returns 404 for unknown ids", async () => {
    const router = createRouterHarness(false);
    registerAnalysis(router);

    await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/missing");
    expect(router.responses.at(-1)).toMatchObject({ status: 403 });

    router.allowHost = true;
    await router.call("GET", "/api/v1/plugins/terminal/analysis/artifacts/missing");
    expect(router.responses.at(-1)).toMatchObject({ status: 404 });
  });

  it("validates Host before route work and never reveals unavailable capture paths", async () => {
    const router = createRouterHarness(false);
    router.setProviderSession({ provider: "claude", sessionId: "private", capturedAt: "now" });
    registerAnalysis(router, {
    });
    await router.call("GET", "/api/v1/plugins/terminal/analysis/catalog");
    expect(router.responses.at(-1)).toMatchObject({ status: 403, body: { error: { code: "analysis_catalog_invalid" } } });

    router.allowHost = true;
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", { cliId: "claude", model: "sonnet", effort: "low" });
    expect(router.responses.at(-1)).toMatchObject({ status: 409, body: { error: { code: "analysis_transcript_missing" } } });
    expect(JSON.stringify(router.responses)).not.toContain("private");
  });

  it("rejects a malicious Origin through the shared gate for every analysis action", async () => {
    const router = createRouterHarness(true);
    // 거부된 요청은 아무 일도 하지 않아야 한다. 설정을 읽었다면 경계 밖에서 일을 시작한 것이다.
    const readAiGatewaySettings = vi.fn(() => ({}) as never);
    registerAnalysis(router, { readAiGatewaySettings });
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
    expect(readAiGatewaySettings).not.toHaveBeenCalled();
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
    registerAnalysis(router, {
      createSession: ((options: { onEvent: (event: AnalysisEvent) => void; capturePath?: string }) => {
        emitters.set(options.capturePath ?? "default", options.onEvent);
        return { start: async () => undefined, send: async () => undefined, dispose: async () => undefined };
      }) as never,
    });

    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    registerAnalysis(router, {
      createSession: () => ({ start: async () => undefined, send: async () => undefined, dispose: async () => undefined }) as never,
    });
    const response = await router.call("GET", "/api/v1/plugins/terminal/analysis/stream");
    expect(response.writes[0]).toBe(`data: ${JSON.stringify({ type: "connected", operationIds: [] })}\n\n`);
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    registerAnalysis(router, {
      createSession: () => ({
        start: async () => undefined,
        send: async () => { throw new Error("/Users/alice/private token"); },
        dispose: async () => undefined,
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
    registerAnalysis(router, {
      createSession: ((options: { onEvent: typeof emit }) => {
        emit = options.onEvent;
        return { start: async () => undefined, send: async () => undefined, dispose };
      }) as never,
    });
    await router.call("POST", "/api/v1/plugins/terminal/analysis/op/start", START_SELECTION);
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
  const state = {
    allowHost: initialHostAllowance,
    operationPresent: true,
    operation,
    origin: "http://127.0.0.1:43210" as string | null,
    bodyGate: null as { readonly entered: () => void; readonly held: Promise<void> } | null,
  };
  const ctx = {
    pluginId: "terminal", basePath: "/api/v1/plugins/terminal",
    registerRouter: (_path: string, registered: typeof handler) => { handler = registered; },
    host: {
      security: {
        validateHost: () => state.allowHost,
        isTerminalAuthorized: (req: { headers: Record<string, string> }) => req.headers.origin !== "https://evil.example",
      },
      http: {
        writeJson: (_res: EventEmitter, status: number, body: unknown) => responses.push({ status, body }),
        readJsonBody: async (req: EventEmitter & { body?: unknown }) => {
          const gate = state.bodyGate;
          if (gate) { state.bodyGate = null; gate.entered(); await gate.held; }
          return req.body ?? null;
        },
      },
      operations: { get: (id: string) => state.operationPresent && id === "op" ? state.operation : null },
      paths: { resolveTheaterPath: () => "/theater" },
      // 분석가는 Console origin이 있어야 게이트웨이 주소를 조립할 수 있다.
      server: { origin: () => state.origin },
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
      state.operation.payload = {
        ...state.operation.payload,
        session: {
          harness: "claude-code",
          id: providerSession.sessionId,
          capturedAt: providerSession.capturedAt,
          ...(providerSession.transcriptPath ? { transcriptPath: providerSession.transcriptPath } : {}),
          ...(providerSession.source ? { source: providerSession.source } : {}),
        },
      };
    },
    setOrigin(origin: string | null) { state.origin = origin; },
    /** 다음 요청의 본문 읽기를 붙잡아, 준비 단계 한가운데를 관측할 수 있는 지점으로 만든다. */
    holdNextBodyRead(): { readonly entered: Promise<void>; readonly release: () => void } {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      state.bodyGate = { entered, held };
      return { entered: enteredPromise, release };
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
