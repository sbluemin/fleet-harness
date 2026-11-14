import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { DESKTOP_BROWSER_FRAME_PATH, DESKTOP_BROWSER_OWNER_HEADER, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_VIEW_HEADER } from "@fleet-console/protocol/desktop";
import { browserSurfaceMode } from "../core/host/shell/desktop-contract.js";
import { DesktopEngine, VIEWER_WATCH_LEASE_MS, ViewerFrameClosedError } from "../features/browser/host/desktop-engine.js";
import { createBrowserDesktopRouter } from "../features/browser/host/desktop-routes.js";
import { BrowserPolicyError, BrowserService } from "../features/browser/host/service.js";
import { createBrowserRouter } from "../features/browser/host/routes.js";
import { BROWSER_GLOBAL_ID } from "../features/browser/shared/browser-id.js";

describe("managed desktop browser engine", () => {
  it("keeps tabs when another host is proposed, and serves only the newest watched frame", async () => {
    const engine = new DesktopEngine({ publish: () => {}, log: () => {} });
    engine.subscriberOpened("manager");
    engine.setHost("manager");
    engine.relay("manager", { hello: { product: "Chrome/1", userAgent: "Mozilla/5.0", hostLabel: "studio", platform: "darwin", accessPath: "loopback" } });
    expect(engine.executionHello()).toMatchObject({ hostLabel: "studio", platform: "darwin", accessPath: "loopback" });
    const context = await engine.send<{ browserContextId: string }>("Target.createBrowserContext", {});
    const creating = engine.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
    const viewId = engine.snapshot().views[0]!.id;
    engine.relay("manager", { attached: [viewId] });
    expect((await creating).targetId).toBe(viewId);

    expect(engine.setHost("remote-session")).toBe(false);
    expect(engine.currentHost).toBe("manager");
    expect(engine.snapshot().views).toHaveLength(1);

    const release = engine.acquireWatch(viewId);
    expect(engine.snapshot().watchedViewIds).toEqual([viewId]);
    const first = Buffer.from([0xff, 0xd8, 0x01]);
    const second = Buffer.from([0xff, 0xd8, 0x02]);
    expect(engine.ingestFrame(viewId, first, 10, 8)?.seq).toBe(1);
    const latest = engine.ingestFrame(viewId, second, 12, 9);
    expect(latest).toMatchObject({ seq: 2, width: 12, height: 9 });
    expect(engine.frameIfNewer(viewId, 0)?.bytes).toEqual(second);
    expect(engine.frameIfNewer(viewId, 2)).toBeNull();
    await expect(engine.waitForFrame(viewId, 1, 0)).resolves.toMatchObject({ seq: 2 });

    const pending = engine.waitForFrame(viewId, 2, 1000);
    const third = engine.ingestFrame(viewId, Buffer.from([0xff, 0xd8, 0x03]), 12, 9);
    await expect(pending).resolves.toMatchObject({ seq: third!.seq });

    vi.useFakeTimers();
    try {
      release(true);
      expect(engine.snapshot().watchedViewIds).toEqual([viewId]);
      vi.advanceTimersByTime(VIEWER_WATCH_LEASE_MS);
      expect(engine.snapshot().watchedViewIds).toEqual([]);
      expect(engine.frameIfNewer(viewId, 0)).toBeNull();
    } finally { vi.useRealTimers(); }

    // Monotonic seq survives watch lease expiration, and one viewer's unwatch keeps another viewer's live ticket.
    const releaseA = engine.acquireWatch(viewId);
    const releaseB = engine.acquireWatch(viewId);
    const resumed = engine.waitForFrame(viewId, third!.seq, 1000);
    releaseA(false);
    engine.releaseWatchLease(viewId);
    expect(engine.snapshot().watchedViewIds).toEqual([viewId]);
    const fourth = engine.ingestFrame(viewId, Buffer.from([0xff, 0xd8, 0x04]), 12, 9);
    expect(fourth!.seq).toBe(4);
    await expect(resumed).resolves.toMatchObject({ seq: 4 });
    releaseB(false);
    expect(engine.snapshot().watchedViewIds).toEqual([]);

    const closed = engine.waitForFrame(viewId, 0, 1000);
    engine.send("Target.closeTarget", { targetId: viewId });
    await expect(closed).rejects.toBeInstanceOf(ViewerFrameClosedError);
    expect(engine.snapshot().watchedViewIds).toEqual([]);
  });
});

describe("managed desktop browser routes", () => {
  it("admits only the managing desktop on loopback and rejects viewer writes", async () => {
    const engine = new DesktopEngine({ publish: () => {}, log: () => {} });
    let connected = false;
    const service = new BrowserService({
      enabled: () => true,
      availability: () => ({
        available: connected,
        reason: connected ? null : "desktop_required",
        host: connected ? "manager" : null,
        executionHost: connected
          ? { managed: true, connected: true, status: "connected", hostLabel: "studio", platform: "darwin", accessPath: "loopback" }
          : { managed: false, connected: false, status: "unmanaged", hostLabel: null, platform: null, accessPath: null },
      }),
      desktop: engine,
      log: () => {},
      defaultProfile: { read: () => null, write: () => {} },
    });
    let gate: "ok" | "missing" | "forbidden" = "missing";
    let loopback = true;
    const seen: { status?: number; body?: unknown } = {};
    const desktop = createBrowserDesktopRouter({
      desktopEngine: engine,
      browserService: service,
      desktopBrowserSseSubscribers: new Map(),
      isLoopbackListener: () => loopback,
      managerGate: () => gate,
      readJsonBody: async () => null,
      writeJson: (_res, status, body) => { seen.status = status; seen.body = body; },
      writeNoContent: (res) => { seen.status = 204; res.end(); },
      withSecurityHeaders: (headers) => headers,
      encodeSseData: () => "",
    });
    const call = (pathname: string, headers: Record<string, string | undefined> = {}, method = "GET") => desktop({
      req: request(method, headers),
      res: { end() {}, writeHead() { return this; }, write() { return true; }, on() { return this; }, writableEnded: false, destroyed: false } as unknown as ServerResponse,
      pathname,
    });

    loopback = false;
    await call(DESKTOP_BROWSER_PATH);
    expect(seen).toMatchObject({ status: 404 });
    loopback = true;
    gate = "missing";
    await call(DESKTOP_BROWSER_PATH);
    expect(seen).toMatchObject({ status: 401 });
    gate = "forbidden";
    await call(DESKTOP_BROWSER_PATH, { [DESKTOP_BROWSER_OWNER_HEADER]: "other", "sec-fetch-site": "cross-site" });
    expect(seen).toMatchObject({ status: 403 });
    gate = "ok";
    await call(DESKTOP_BROWSER_PATH);
    expect(seen.status).toBe(200);
    expect(engine.currentHost).toBe("manager");
    engine.subscriberOpened("manager");

    const context = await engine.send<{ browserContextId: string }>("Target.createBrowserContext", {});
    const creating = engine.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
    const viewId = engine.snapshot().views[0]!.id;
    engine.relay("manager", { attached: [viewId] });
    await creating;
    engine.acquireWatch(viewId);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await desktop({
      req: request("POST", { "content-type": "image/jpeg", [DESKTOP_BROWSER_VIEW_HEADER]: viewId, "x-fleet-frame-width": "8", "x-fleet-frame-height": "4" }, jpeg),
      res: { end() { seen.status = 204; }, writeHead() { return this; } } as unknown as ServerResponse,
      pathname: DESKTOP_BROWSER_FRAME_PATH,
    });
    expect(seen.status).toBe(204);
    expect(engine.frameIfNewer(viewId, 0)?.bytes).toEqual(jpeg);
    const stale = Buffer.from([0xff, 0xd8, 0x00]);
    await desktop({
      req: request("POST", { "content-type": "image/jpeg", [DESKTOP_BROWSER_VIEW_HEADER]: viewId, "x-fleet-frame-width": "8", "x-fleet-frame-height": "4" }, stale),
      res: { end() { seen.status = 204; }, writeHead() { return this; } } as unknown as ServerResponse,
      pathname: DESKTOP_BROWSER_FRAME_PATH,
    });
    expect(engine.frameIfNewer(viewId, 0)?.bytes).toEqual(stale);
    expect(engine.frameIfNewer(viewId, 0)?.seq).toBe(2);

    let native = false;
    let currentUrl = `http://127.0.0.1/api/v1/browser/viewer/frame?tabId=${viewId}&afterSeq=99&waitMs=0`;
    const browser = createBrowserRouter({
      browserService: service,
      desktopEngine: engine,
      browserMcp: { pasteIntoTerminal: () => false },
      objectiveRecords: { get: () => null },
      isWriteAdmitted: () => true,
      isExactConsoleOrigin: () => true,
      surfaceMode: () => native ? "native" : "viewer",
      isNativeBrowserWrite: () => native,
      isManagingDesktopProcess: () => false,
      viewerFrameRead: () => "ok",
      isLoopbackListener: () => true,
      isSameOriginConsoleRead: () => true,
      writeJson: (_res, status, body) => { seen.status = status; seen.body = body; },
      readJsonBody: async <T,>() => ({ action: "create" }) as T,
      readUrl: () => new URL(currentUrl),
      withSecurityHeaders: (headers) => headers,
    });
    await browser({ req: request("POST"), res: { setHeader() {} } as unknown as ServerResponse, pathname: "/api/v1/browser/objectives/global/tabs" });
    expect(seen).toMatchObject({ status: 403, body: { error: "browser_viewer_read_only" } });
    expect(engine.snapshot().views).toHaveLength(1);
    native = true;
    connected = true;
    service.reconcile();
    expect(engine.snapshot().views).toHaveLength(1);
    expect(engine.currentHost).toBe("manager");

    // Public tab.id differs from engine viewId; viewer frame & unwatch routes must translate tabId → viewId.
    const autoRelay = setInterval(() => {
      const snap = engine.snapshot();
      for (const candidate of snap.views) engine.relay("manager", { attached: [candidate.id], sizes: [{ viewId: candidate.id, width: 800, height: 600, scale: 1 }] });
      for (const cmd of snap.commands) engine.relay("manager", { results: [{ id: cmd.id, result: cmd.method === "Page.getNavigationHistory" ? { currentIndex: 0, entries: [{ url: "about:blank" }] } : {} }] });
    }, 5);
    let createdTabId = "";
    try {
      const createdTab = await service.createTab(BROWSER_GLOBAL_ID, "about:blank", "user");
      createdTabId = createdTab.id;
    } finally { clearInterval(autoRelay); }
    const mappedViewId = service.viewIdOfTab(BROWSER_GLOBAL_ID, createdTabId)!;
    expect(mappedViewId).toBeTruthy();
    expect(createdTabId).not.toBe(mappedViewId);
    engine.ingestFrame(mappedViewId, jpeg, 8, 4);
    currentUrl = `http://127.0.0.1/api/v1/browser/viewer/frame?tabId=${createdTabId}&afterSeq=0&waitMs=50`;
    let frameBytes: Buffer | null = null;
    const frameRes = {
      writableEnded: false,
      destroyed: false,
      on() { return frameRes; },
      off() { return frameRes; },
      writeHead(status: number) { seen.status = status; return frameRes; },
      end(chunk?: Buffer) { if (chunk) frameBytes = chunk; frameRes.writableEnded = true; },
    };
    await browser({
      req: request("GET"),
      res: frameRes as unknown as ServerResponse,
      pathname: "/api/v1/browser/viewer/frame",
    });
    expect(seen.status).toBe(200);
    expect(frameBytes).toEqual(jpeg);
    expect(engine.snapshot().watchedViewIds).toContain(mappedViewId);
    currentUrl = `http://127.0.0.1/api/v1/browser/viewer/unwatch?tabId=${createdTabId}`;
    await browser({
      req: request("POST"),
      res: { writeHead(status: number) { seen.status = status; return this; }, end() {} } as unknown as ServerResponse,
      pathname: "/api/v1/browser/viewer/unwatch",
    });
    expect(seen.status).toBe(204);
    expect(engine.snapshot().watchedViewIds).not.toContain(mappedViewId);
  });
});

describe("remote desktop browser control", () => {
  it("classifies only a non-loopback desktop with the remote-control flag as remote", () => {
    expect(browserSurfaceMode({ loopback: true, desktopShell: true, managingShellProven: true, remoteControl: true })).toBe("native");
    expect(browserSurfaceMode({ loopback: false, desktopShell: true, managingShellProven: false, remoteControl: true })).toBe("remote");
    expect(browserSurfaceMode({ loopback: false, desktopShell: true, managingShellProven: false })).toBe("viewer");
    expect(browserSurfaceMode({ loopback: false, desktopShell: false, managingShellProven: false, remoteControl: true })).toBe("viewer");
  });

  it("opens objective control writes for a remote desktop and keeps vault and import routes closed", async () => {
    const engine = new DesktopEngine({ publish: () => {}, log: () => {} });
    const service = new BrowserService({
      enabled: () => true,
      availability: () => ({ available: false, reason: "desktop_required", host: null, executionHost: { managed: false, connected: false, status: "unmanaged", hostLabel: null, platform: null, accessPath: null } }),
      desktop: engine,
      log: () => {},
      defaultProfile: { read: () => null, write: () => {} },
    });
    let remote = false;
    const seen: { status?: number; body?: unknown } = {};
    const browser = createBrowserRouter({
      browserService: service,
      desktopEngine: engine,
      browserMcp: { pasteIntoTerminal: () => false },
      objectiveRecords: { get: () => null },
      isWriteAdmitted: () => true,
      isExactConsoleOrigin: () => true,
      surfaceMode: () => remote ? "remote" : "viewer",
      isNativeBrowserWrite: () => false,
      isRemoteBrowserControl: () => remote,
      isManagingDesktopProcess: () => false,
      viewerFrameRead: () => "ok",
      isLoopbackListener: () => false,
      isSameOriginConsoleRead: () => true,
      writeJson: (_res, status, body) => { seen.status = status; seen.body = body; },
      readJsonBody: async <T,>() => ({ url: "https://example.com", action: "take", spaceId: "default" }) as T,
      readUrl: () => new URL("http://127.0.0.1/api/v1/browser/passwords"),
      withSecurityHeaders: (headers) => headers,
    });
    const call = (pathname: string, method = "POST") => browser({
      req: request(method),
      res: { setHeader() {}, writeHead() { return this; }, end() {} } as unknown as ServerResponse,
      pathname,
    });

    await call("/api/v1/browser/objectives/global/navigate");
    expect(seen).toMatchObject({ status: 403, body: { error: "browser_viewer_read_only" } });
    remote = true;
    await call("/api/v1/browser/objectives/global/navigate");
    expect(seen.status).toBe(409);
    expect(seen.body).toMatchObject({ error: "browser_unavailable" });
    await call("/api/v1/browser/objectives/global/paste");
    expect(seen).toMatchObject({ status: 403, body: { error: "browser_viewer_read_only" } });
    await call("/api/v1/browser/import-sources", "GET");
    expect(seen).toMatchObject({ status: 403, body: { error: "browser_viewer_read_only" } });
    await call("/api/v1/browser/suggestion-settings", "POST");
    expect(seen).toMatchObject({ status: 403, body: { error: "browser_viewer_read_only" } });
    await call("/api/v1/browser/passwords", "POST");
    expect(seen).toMatchObject({ status: 403, body: { error: "browser_viewer_read_only" } });

    const popup = { id: "popup-1", tabId: "tab-1", multiple: false, rect: { x: 1, y: 2, width: 3, height: 4 }, options: [{ index: 0, label: "A", value: "a", disabled: false, selected: true }] };
    service.noteRemotePrompts({ selectPopup: popup });
    const snapshot = service.viewerSnapshot(BROWSER_GLOBAL_ID, { remoteControl: true });
    expect(snapshot.remoteControl).toBe(true);
    expect(snapshot.selectPopup).toEqual(popup);
    expect(snapshot.chrome?.spaces.some((space) => space.control === "agent")).toBe(true);
    expect(service.viewerSnapshot(BROWSER_GLOBAL_ID).remoteControl).toBeUndefined();
  });

  it("blocks human input while an agent drives the tab and allows it after take", async () => {
    const engine = new DesktopEngine({ publish: () => {}, log: () => {} });
    engine.subscriberOpened("manager");
    engine.setHost("manager");
    const service = new BrowserService({
      enabled: () => true,
      availability: () => ({
        available: true,
        reason: null,
        host: "manager",
        executionHost: { managed: true, connected: true, status: "connected", hostLabel: "studio", platform: "darwin", accessPath: "loopback" },
      }),
      desktop: engine,
      log: () => {},
      defaultProfile: { read: () => null, write: () => {} },
    });
    const autoRelay = setInterval(() => {
      const snap = engine.snapshot();
      for (const candidate of snap.views) engine.relay("manager", { attached: [candidate.id], sizes: [{ viewId: candidate.id, width: 800, height: 600, scale: 1 }] });
      for (const cmd of snap.commands) engine.relay("manager", { results: [{ id: cmd.id, result: cmd.method === "Page.getNavigationHistory" ? { currentIndex: 0, entries: [{ url: "about:blank" }] } : {} }] });
    }, 5);
    let tabId = "";
    try {
      tabId = (await service.createTab(BROWSER_GLOBAL_ID, "about:blank", "agent", { caller: { participantId: "agent-1", spaceId: "default", ownerId: "agent-1" } })).id;
    } finally { clearInterval(autoRelay); }
    const batch = { tabId, events: [{ kind: "focus" as const, focused: true }] };
    await expect(service.dispatchRemoteInput(BROWSER_GLOBAL_ID, batch)).rejects.toBeInstanceOf(BrowserPolicyError);
    await expect(service.dispatchRemoteInput(BROWSER_GLOBAL_ID, batch)).rejects.toMatchObject({ code: "browser_agent_in_control" });
    const delivered: string[] = [];
    service.setRemoteInputRelay(async (input) => { delivered.push(input.tabId); });
    expect(service.setControl(BROWSER_GLOBAL_ID, "default", "take")).toBe("user");
    await service.dispatchRemoteInput(BROWSER_GLOBAL_ID, batch);
    expect(delivered).toEqual([tabId]);
    expect(service.setControl(BROWSER_GLOBAL_ID, "default", "return")).toBe("agent");
    await expect(service.dispatchRemoteInput(BROWSER_GLOBAL_ID, batch)).rejects.toMatchObject({ code: "browser_agent_in_control" });
    expect(delivered).toEqual([tabId]);
  });
});

function request(method: string, headers: Record<string, string | undefined> = {}, body?: Buffer): IncomingMessage {
  const stream = Readable.from(body ? [body] : []);
  return Object.assign(stream, { method, headers }) as IncomingMessage;
}
