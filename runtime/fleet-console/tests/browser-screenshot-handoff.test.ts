import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBrowserToolSpecs } from "../features/browser/host/tools.js";
import { createBrowserScreenshotStore, resolveBrowserScreenshotNamespaceRoot } from "../features/browser/host/screenshot-store.js";
import { BrowserService } from "../features/browser/host/service.js";
import { CdpError, type CdpEvent, type CdpListener } from "../features/browser/host/cdp.js";
import type { DesktopEngine } from "../features/browser/host/desktop-engine.js";

/**
 * 스크린샷이 에이전트에게 닿는 계약. 캡처는 도구 결과에 실리지 않고 언제나 Console 호스트(에이전트가 도는
 * 그 기계)의 파일로 건네진다 — 결과에 실린 base64 는 이미지가 아니라 텍스트로 값이 매겨져 한 장이 수만
 * 토큰을 먹고, 상한을 넘기면 호출한 CLI 가 결과를 통째로 흘려보내 **모델은 이미지를 아예 보지 못한다**.
 * 그 파일은 사람이 본 페이지의 사본이므로 소유자만 읽을 수 있어야 하며 브라우저를 거둘 때 함께 사라져야 한다.
 *
 * 같은 대표 경계에서 뷰포트 복원·stale ref·중단 방어를 이어서 검증한다 — 헬퍼 순수함수나 도구 문구 핀이 아니라
 * BrowserService 가 CDP/셸 스텁 위에서 실제로 거절·동기화하는지.
 */

const OPERATION = "operation-screenshot";
const CAPTURE = Buffer.alloc(8_000, 0x7f);

function screenshotResult(width = 1404, height = 1177) {
  return {
    data: CAPTURE.toString("base64"),
    mimeType: "image/jpeg",
    width,
    height,
    viewport: { width, height, preset: "responsive" as const, followsPane: true },
    layout: { width, height },
    staleViewport: false,
  };
}

function screenshotTool(bytes: Buffer, screenshots: ReturnType<typeof createBrowserScreenshotStore>, aborted = false) {
  const service = {
    agentCall: (_id: string, _signal: AbortSignal, run: (signal: AbortSignal) => Promise<unknown>) => {
      const controller = new AbortController();
      // 브라우저를 거두면 진행 중 호출은 이 자리에서 끊긴다 — 회수는 그보다 먼저 지나간다.
      if (aborted) controller.abort();
      return run(controller.signal);
    },
    screenshot: () => Promise.resolve({ ...screenshotResult(), data: bytes.toString("base64") }),
  };
  const specs = createBrowserToolSpecs({ service: service as never, screenshots });
  const computer = specs.find((spec) => spec.id === "computer")!;
  return () => computer.execute({ action: "screenshot" }, { sessionLabel: OPERATION } as never) as Promise<{ content: { type: string; text?: string }[] }>;
}

function store() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "browser-screenshot-"));
  return { screenshots: createBrowserScreenshotStore({ dataDir }), root: resolveBrowserScreenshotNamespaceRoot(dataDir) };
}

describe("operation browser screenshots", () => {
  it("hands every screenshot over as a file instead of loading the result with the image, and takes it back with the browser", async () => {
    const { screenshots } = store();
    try {
      const { content } = await screenshotTool(CAPTURE, screenshots)();

      // 결과에는 그림이 없다 — 이미지 블록도, 텍스트로 새어 나온 base64 도.
      expect(content.every((block) => block.type === "text")).toBe(true);
      expect(content.map((block) => block.text ?? "").join("\n")).not.toContain(CAPTURE.toString("base64").slice(0, 64));

      const filePath = /Read the image file to see it: (.+)$/.exec(content[0]?.text ?? "")?.[1];
      expect(filePath).toBeTruthy();
      // 좌표 계는 캡처 기준을 따른다 — 다음 클릭이 이 픽셀을 쓴다.
      expect(content[0]?.text).toMatch(/Screenshot capture 1404x1177 CSS px/);

      // 화질을 깎아 내려보내지 않는다 — 파일은 캡처 그대로다.
      expect((await readFile(filePath!)).equals(CAPTURE)).toBe(true);
      expect(statSync(filePath!).mode & 0o777).toBe(0o600);

      screenshots.release(OPERATION);
      await expect(readFile(filePath!)).rejects.toThrow();
    } finally {
      screenshots.cleanup();
    }
  });

  it("writes nothing when the call was already cut off", async () => {
    const { screenshots, root } = store();
    try {
      // 거둔 뒤에 끝난 캡처가 파일을 쓰면 회수가 지나간 디렉터리를 되살리며 그 페이지가 남는다.
      const { content } = await screenshotTool(CAPTURE, screenshots, true)();
      expect(content[0]?.text).toMatch(/Screenshot capture 1404x1177 CSS px/);
      expect(existsSync(root)).toBe(false);
    } finally {
      screenshots.cleanup();
    }
  });

  it("leaves a serving console's screenshots alone when a second one starts and gives up", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "browser-screenshot-"));
    const serving = createBrowserScreenshotStore({ dataDir });
    try {
      const filePath = serving.save(OPERATION, CAPTURE, "jpg");

      // 같은 데이터 루트로 두 번째 Console 이 올라온다. 서버는 기동 끝에서야 runtime lock 을 잡으므로
      // 이 프로세스는 아직 자기가 질지 모른 채 만들어지고, 잠금에 실패하면 정리하며 내려간다.
      const losing = createBrowserScreenshotStore({ dataDir });
      losing.cleanup();

      expect(existsSync(filePath)).toBe(true);
    } finally {
      serving.cleanup();
    }
  });
});

type StubOptions = {
  layout?: { width: number; height: number };
  resolveNode?: "ok" | "detached";
  box?: { content: number[] };
  hit?: { ok: boolean; reason?: string; x: number; y: number; disabled: boolean; hit: { tag: string; id: string | null; text: string; disabled: boolean; selector: string } | null };
  onDispatch?: () => void;
  delayBoxMs?: number;
};

function createStubDesktop(options: StubOptions = {}) {
  const listeners = new Set<CdpListener>();
  const sizes = new Map<string, { width: number; height: number; scale: number }>();
  const viewId = "view-stub";
  let layout = options.layout ?? { width: 1386, height: 1163 };
  const desktop = {
    currentHost: "local" as string | null,
    get connected() { return true; },
    closed: new Promise<void>(() => undefined),
    viewSize: (id: string) => sizes.get(id) ?? null,
    viewOperation: () => OPERATION,
    place: () => undefined,
    bindView: () => undefined,
    setHost: () => false,
    subscriberOpened: () => undefined,
    subscriberClosed: () => undefined,
    snapshot: () => ({ generation: 0, views: [], commands: [] }),
    emptySnapshot: () => ({ generation: 0, views: [], commands: [] }),
    relay: () => undefined,
    publish: () => undefined,
    on(listener: CdpListener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event: CdpEvent) { for (const listener of listeners) listener(event); },
    setPaneSize(size: { width: number; height: number; scale?: number }) {
      const next = { width: size.width, height: size.height, scale: size.scale ?? 1 };
      sizes.set(viewId, next);
      desktop.emit({ method: "Fleet.viewResized", params: next, sessionId: viewId });
    },
    setLayout(next: { width: number; height: number }) { layout = next; },
    async send<T = Record<string, unknown>>(method: string, _params: Record<string, unknown> = {}, _sessionId?: string): Promise<T> {
      switch (method) {
        case "Browser.getVersion":
          return { product: "Chrome/150.0.0.0", userAgent: "Mozilla/5.0 Chrome/150.0.0.0", protocolVersion: "1.3" } as T;
        case "Target.createBrowserContext":
          return { browserContextId: "ctx-stub" } as T;
        case "Target.createTarget":
          return { targetId: viewId } as T;
        case "Target.attachToTarget":
          return { sessionId: viewId } as T;
        case "Target.activateTarget":
        case "Target.closeTarget":
        case "Target.disposeBrowserContext":
        case "Page.enable":
        case "Runtime.enable":
        case "Network.enable":
        case "Log.enable":
        case "DOM.enable":
        case "Emulation.setFocusEmulationEnabled":
        case "Emulation.setUserAgentOverride":
        case "Emulation.clearDeviceMetricsOverride":
        case "Emulation.setDeviceMetricsOverride":
        case "Emulation.setEmulatedMedia":
          return {} as T;
        case "Page.getLayoutMetrics":
          return { cssLayoutViewport: { clientWidth: layout.width, clientHeight: layout.height } } as T;
        case "Page.captureScreenshot":
          return { data: Buffer.alloc(32, 1).toString("base64") } as T;
        case "DOM.resolveNode":
          if (options.resolveNode === "detached") throw new CdpError(method, -32000, "Node with given id does not belong to the document (detached)");
          return { object: { objectId: "obj-1" } } as T;
        case "DOM.getBoxModel": {
          if (options.delayBoxMs) await new Promise((resolve) => setTimeout(resolve, options.delayBoxMs));
          const content = options.box?.content ?? [10, 10, 30, 10, 30, 30, 10, 30];
          return { model: { content } } as T;
        }
        case "Runtime.callFunctionOn": {
          const declaration = String((_params as { functionDeclaration?: string }).functionDeclaration ?? "");
          if (declaration.includes("scrollIntoView")) return {} as T;
          if (declaration.includes("elementFromPoint") || declaration.includes("getBoundingClientRect")) {
            return {
              result: {
                value: options.hit ?? { ok: true, x: 20, y: 20, disabled: false, hit: { tag: "button", id: "go", text: "Go", disabled: false, selector: "button#go" } },
              },
            } as T;
          }
          return { result: { value: undefined } } as T;
        }
        case "Runtime.evaluate":
          return { result: { type: "undefined" } } as T;
        case "Input.dispatchMouseEvent":
          options.onDispatch?.();
          return {} as T;
        default:
          return {} as T;
      }
    },
    async close() { return; },
  };
  return desktop;
}

type StubDesktop = ReturnType<typeof createStubDesktop>;

function createService(desktop: StubDesktop) {
  return new BrowserService({
    enabled: () => true,
    availability: () => ({ available: true, reason: null, host: "local" }),
    log: () => undefined,
    desktop: desktop as unknown as DesktopEngine,
  });
}

describe("operation browser service contracts", () => {
  it("restores desktop viewport from the native pane instead of keeping the previous preset", async () => {
    const desktop = createStubDesktop({ layout: { width: 1386, height: 1163 } });
    const service = createService(desktop);
    try {
      await service.createTab(OPERATION, null, "agent");
      desktop.setPaneSize({ width: 1386, height: 1163, scale: 2 });

      await service.setViewport(OPERATION, { preset: "mobile" }, "agent");
      expect(service.state(OPERATION).viewport).toMatchObject({ width: 375, height: 812, preset: "mobile" });

      // desktop 복귀: 직전 375x812 가 아니라 pane 실측.
      const restored = await service.setViewport(OPERATION, { preset: "responsive" }, "agent");
      expect(restored).toMatchObject({ width: 1386, height: 1163, preset: "responsive" });
      expect(service.state(OPERATION).viewport).toMatchObject({ width: 1386, height: 1163, preset: "responsive" });

      // 임의 크기는 실제 에뮬레이션으로 잠근다(pane 과 분리).
      const custom = await service.setViewport(OPERATION, { preset: "responsive", width: 1200, height: 900 }, "agent");
      expect(custom).toMatchObject({ width: 1200, height: 900, preset: "responsive" });
    } finally {
      await service.dispose();
    }
  });

  it("rejects a mapped but detached ref as a stale reference before dispatching a pointer", async () => {
    const dispatches: string[] = [];
    const desktop = createStubDesktop({
      resolveNode: "detached",
      onDispatch: () => { dispatches.push("pointer"); },
    });
    const service = createService(desktop);
    try {
      const tab = await service.createTab(OPERATION, null, "agent");
      // read_page 가 남긴 것처럼 매핑만 있고 노드는 이미 떨어졌다.
      const opTab = (service as unknown as { operations: Map<string, { tabs: Map<string, { refs: Map<string, number> }> }> }).operations.get(OPERATION)!.tabs.get(tab.id)!;
      opTab.refs.set("ref_1", 99);

      await expect(service.clickRef(OPERATION, "ref_1", { button: "left", clickCount: 1 })).rejects.toMatchObject({
        code: "browser_ref_unknown",
      });
      expect(dispatches).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("does not dispatch a pointer after the agent call is aborted during ref settling", async () => {
    const dispatches: string[] = [];
    const desktop = createStubDesktop({
      delayBoxMs: 40,
      box: { content: [0, 0, 10, 0, 10, 10, 0, 10] },
      onDispatch: () => { dispatches.push("pointer"); },
    });
    const service = createService(desktop);
    try {
      const tab = await service.createTab(OPERATION, null, "agent");
      const opTab = (service as unknown as { operations: Map<string, { tabs: Map<string, { refs: Map<string, number> }> }> }).operations.get(OPERATION)!.tabs.get(tab.id)!;
      opTab.refs.set("ref_1", 7);

      const controller = new AbortController();
      const pending = service.clickRef(OPERATION, "ref_1", { button: "left", clickCount: 1, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await expect(pending).rejects.toThrow(/browser_call_interrupted/);
      expect(dispatches).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("flags a stale stored viewport against layout before healing, while capture uses layout geometry", async () => {
    const desktop = createStubDesktop({ layout: { width: 1386, height: 1163 } });
    const service = createService(desktop);
    try {
      await service.createTab(OPERATION, null, "agent");
      desktop.setPaneSize({ width: 1386, height: 1163, scale: 1 });
      await service.setViewport(OPERATION, { preset: "mobile" }, "agent");
      // 에뮬레이션을 직접 걷어 layout 만 desktop 크기로 두고, 저장 뷰포트는 mobile 로 남겨 stale 을 재현한다.
      desktop.setLayout({ width: 1386, height: 1163 });
      const op = (service as unknown as { operations: Map<string, { viewportFollowsPane: boolean }> }).operations.get(OPERATION)!;
      op.viewportFollowsPane = true;

      const shot = await service.screenshot(OPERATION, { format: "jpeg" });
      expect(shot.staleViewport).toBe(true);
      expect(shot.width).toBe(1386);
      expect(shot.height).toBe(1163);
      expect(shot.layout).toEqual({ width: 1386, height: 1163 });
    } finally {
      await service.dispose();
    }
  });
});

describe("operation browser tool target admission", () => {
  it("requires a click target and forwards abortable ref clicks through the service", async () => {
    const { screenshots } = store();
    const calls: Array<{ name: string; signalAborted: boolean }> = [];
    const service = {
      agentCall: (_id: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<unknown>) => run(signal ?? new AbortController().signal),
      screenshot: () => Promise.resolve(screenshotResult()),
      clickAt: async (_op: string, _x: number, _y: number, options: { signal?: AbortSignal }) => {
        calls.push({ name: "clickAt", signalAborted: options.signal?.aborted === true });
        return { dispatched: true as const, x: 1, y: 2, button: "left" as const, clickCount: 1, ref: null, hit: null, note: null };
      },
      clickRef: async (_op: string, _ref: string, options: { signal?: AbortSignal }) => {
        calls.push({ name: "clickRef", signalAborted: options.signal?.aborted === true });
        return { dispatched: true as const, x: 3, y: 4, button: "left" as const, clickCount: 1, ref: "ref_1", hit: null, note: null };
      },
      state: () => ({ viewport: { width: 1404, height: 1177 } }),
    };
    const computer = createBrowserToolSpecs({ service: service as never, screenshots }).find((spec) => spec.id === "computer")!;

    const missing = await computer.execute({ action: "left_click" }, { sessionLabel: OPERATION, signal: new AbortController().signal } as never) as { isError: boolean; content: { text?: string }[] };
    expect(missing.isError).toBe(true);
    expect(missing.content.some((block) => block.text?.includes("browser_click_target_required"))).toBe(true);

    const byRef = await computer.execute({ action: "left_click", ref: "ref_1" }, { sessionLabel: OPERATION, signal: new AbortController().signal } as never) as { isError: boolean };
    expect(byRef.isError).toBe(false);
    expect(calls.some((call) => call.name === "clickRef" && call.signalAborted === false)).toBe(true);
  });
});
