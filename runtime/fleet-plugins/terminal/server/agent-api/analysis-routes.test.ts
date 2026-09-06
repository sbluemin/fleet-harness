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
