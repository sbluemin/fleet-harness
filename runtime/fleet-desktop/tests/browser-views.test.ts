import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBrowserHistoryStorage, readChromeHistory } from "../src/browser-history.js";
import { DESKTOP_BROWSER_EVENT, DESKTOP_BROWSER_EVENTS_PATH, DESKTOP_BROWSER_FRAME_CSS_HEIGHT_HEADER, DESKTOP_BROWSER_FRAME_CSS_WIDTH_HEADER, DESKTOP_BROWSER_FRAME_PATH, DESKTOP_BROWSER_FRAME_WIDTH_HEADER, DESKTOP_BROWSER_OWNER_HEADER, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_RELAY_PATH, DESKTOP_BROWSER_VIEW_HEADER, type DesktopBrowserRelay, type DesktopBrowserSnapshot } from "@fleet-console/protocol/desktop";
import type { WebContentsView } from "electron";
import { createDesktopShellWindow, createDesktopViewStack, parkedNativeBounds } from "../src/shell-window.js";
import { createBrowserSurface } from "../src/browser-surface.js";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createDesktopBrowserViews, type PageHost } from "../src/browser-views.js";
import { webRequestUrlMatches } from "./web-request-match.js";

describe("browser profile history storage boundary", () => {
  it("reads only a Chrome snapshot, contains durable writes, and clears history with its icons", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-history-contract-"));
    let source: DatabaseSync | null = null;
    try {
      const chrome = path.join(root, "chrome");
      const profile = path.join(chrome, "Profile 1");
      fs.mkdirSync(profile, { recursive: true });
      source = new DatabaseSync(path.join(profile, "History"));
      source.exec("PRAGMA journal_mode=WAL; CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER); INSERT INTO urls VALUES ('https://fixture.invalid/docs', 'Fixture title', 3, 13400000000000000, 0), ('https://hidden.invalid', 'Hidden', 1, 13400000000000000, 1)");
      const before = fs.readdirSync(profile).map((name) => [name, fs.readFileSync(path.join(profile, name))] as const);
      const entries = readChromeHistory({ profileId: "Profile 1", userDataDir: chrome, tempRoot: root });
      expect(entries).toEqual([{ url: "https://fixture.invalid/docs", title: "Fixture title", visits: 3, lastVisited: 1755526400000 }]);
      for (const [name, bytes] of before) expect(fs.readFileSync(path.join(profile, name))).toEqual(bytes);
      expect(fs.readdirSync(root).sort()).toEqual(["chrome"]);
      const browserRoot = path.join(root, "browser-profiles");
      const storage = createBrowserHistoryStorage(browserRoot);
      const initial = storage.command({ action: "read", browserProfile: "default" });
      const data = JSON.stringify({ version: 1, entries, icons: { fixture: { type: "image/png", body: "aWNvbg==" } } });
      storage.command({ action: "write", browserProfile: "default", data, revision: initial.revision });
      expect(createBrowserHistoryStorage(browserRoot).command({ action: "read", browserProfile: "default" }).data).toBe(data);
      expect(() => storage.command({ action: "write", browserProfile: "default", data: "stale", revision: initial.revision })).toThrow("browser_history_changed");
      expect(() => storage.command({ action: "read", browserProfile: "../chrome" })).toThrow("browser_profile_invalid");
      fs.symlinkSync(chrome, path.join(browserRoot, "linked"), "dir");
      expect(() => storage.command({ action: "read", browserProfile: "linked" })).toThrow("browser_profile_invalid");
      storage.clear("default");
      expect(fs.existsSync(path.join(browserRoot, "default", "fleet-history.json"))).toBe(false);
      expect(storage.command({ action: "read", browserProfile: "default" }).data).toBeNull();
    } finally { source?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

const REMOTE = "https://100.84.12.7:6768";

function view(id: string): DesktopBrowserSnapshot["views"][number] {
  return { id, objectiveId: "op-1", partition: "fleet-browser-1", profile: null, visible: false, url: "about:blank" };
}

type ViewRequestListener = (details: { url: string; requestHeaders: Record<string, string>; webContentsId?: number }, callback: (response: { requestHeaders?: Record<string, string>; cancel?: boolean }) => void) => void;

function deliverViewRequest(
  filter: { urls: readonly string[] } | null,
  listener: ViewRequestListener | null,
  details: { url: string; requestHeaders: Record<string, string>; webContentsId?: number },
): { called: boolean; requestHeaders?: Record<string, string>; cancel?: boolean } {
  if (!filter || !listener || !filter.urls.some((pattern) => webRequestUrlMatches(details.url, pattern))) return { called: false };
  let response: { requestHeaders?: Record<string, string>; cancel?: boolean } = {};
  listener(details, (next) => { response = next; });
  return { called: true, ...response };
}

/** 셸이 만든 네이티브 뷰 — 이 계약이 보는 것은 만들어졌는지, 닫혔는지, 어떤 CDP 명령을 받았는지뿐이다. */
type OpenHandler = (details: { url: string; disposition: string; features: string; frameName: string; postBody?: unknown }) => { action: string; createWindow?: unknown };
function fakeView(partition: string, created: Array<{ partition: string; closed: boolean; commands: string[]; sent?: Array<{ method: string; params: Record<string, unknown> }>; contents: EventEmitter; openHandler?: OpenHandler; loaded?: string[] }>): WebContentsView {
  const record = {
    partition,
    closed: false,
    commands: [] as string[],
    sent: [] as Array<{ method: string; params: Record<string, unknown> }>,
    contents: new EventEmitter(),
    filter: null as { urls: readonly string[] } | null,
    listener: null as ((details: { url: string; requestHeaders: Record<string, string>; webContentsId?: number }, callback: (response: { requestHeaders?: Record<string, string> }) => void) => void) | null,
    frameSubs: { begin: 0, end: 0 },
    bounds: vi.fn(),
    openHandler: undefined as OpenHandler | undefined,
    loaded: [] as string[],
  };
  created.push(record);
  // 페이지 이동은 뷰가 닫힐 때까지 끝나지 않다가 닫히면 거부된다 — 재기동 순간에 걸려 있던 명령.
  let rejectPending: (error: Error) => void = () => {};
  const contents = Object.assign(record.contents, {
    id: 41,
    session: { webRequest: {
      onBeforeSendHeaders: (filter: { urls: readonly string[] }, listener: typeof record.listener) => { record.filter = filter; record.listener = listener; },
      onHeadersReceived: () => {},
    } },
    debugger: Object.assign(new EventEmitter(), {
      attach: () => {},
      detach: () => {},
      isAttached: () => true,
      sendCommand: (method: string, params?: Record<string, unknown>) => {
        record.commands.push(method);
        record.sent.push({ method, params: params ?? {} });
        return method === "Page.navigate" ? new Promise((_resolve, reject) => { rejectPending = reject; }) : Promise.resolve({});
      },
    }),
    setWindowOpenHandler: (handler: OpenHandler) => { record.openHandler = handler; },
    getURL: () => "https://opener.example/page",
    beginFrameSubscription: () => { record.frameSubs.begin += 1; },
    endFrameSubscription: () => { record.frameSubs.end += 1; },
    loadURL: async (url: string) => { record.loaded.push(url); },
    insertCSS: async () => "",
    isFocused: () => false,
    isDestroyed: () => record.closed,
    close: () => { record.closed = true; rejectPending(new Error("target closed")); },
  });
  return { webContents: contents, setBorderRadius: () => {}, setBounds: record.bounds, setVisible: () => {} } as unknown as WebContentsView;
}

/**
 * 원격 Console 이 셀프 업데이트로 재기동하면 셸에는 같은 origin 의 스트림이 끊겼다 다시 붙는 것으로만 보인다. 새 프로세스는
 * generation 과 명령 id 를 처음부터 다시 세므로, 셸이 옛 수명의 표를 들고 있으면 새 탭의 뷰를 만들지 못하고 Console 은
 * 부착을 기다리다 시간 초과로 실패한다(Desktop 을 다시 켜야만 풀리던 증상).
 */
describe("desktop native browser views across a Console restart", () => {
  // Console 왕복 없이 셸이 Console·크롬·페이지를 같은 조작에서 놓는 대표 수명 계약이다.
  it("owns surface geometry through resize, divider drag, rail expansion, mode change, and disposal", () => {
    let content = { x: 40, y: 30, width: 1400, height: 900 };
    const base = Object.assign(new EventEmitter(), { getContentBounds: () => content, isDestroyed: () => false,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } });
    const makeView = () => {
      const mainFrame = { url: "" };
      const webContents = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false, close: vi.fn(), focus: vi.fn(), reload: vi.fn(), setZoomFactor: vi.fn(),
        setWindowOpenHandler: vi.fn(), loadURL: vi.fn(async (url: string) => { mainFrame.url = url; }),
        loadFile: vi.fn(async (file: string) => { mainFrame.url = pathToFileURL(file).href; }), executeJavaScript: vi.fn(async () => undefined) });
      return { webContents, setBounds: vi.fn(), setVisible: vi.fn(), setBackgroundColor: vi.fn() };
    };
    const consoleView = makeView();
    const stack = createDesktopViewStack(base as never, consoleView as never);
    const shell = createDesktopShellWindow(base as never, consoleView as never, stack);
    const views: ReturnType<typeof makeView>[] = [];
    const changed = vi.fn();
    const actions: string[] = [];
    let zoomFactor = 1;
    const surface = createBrowserSurface({
      main: () => shell,
      createChromeView: () => { const created = makeView(); views.push(created); return created as never; },
      createDividerView: () => { const created = makeView(); views.push(created); return created as never; },
      createWindow: () => { throw new Error("window mode is not part of this contract"); },
      chromeDir: "/assets/browser-chrome", program: () => "", colors: () => null, lang: "en", platform: "linux", scaleFactor: () => 1, zoom: () => zoomFactor,
      act: (control, role, action) => {
        actions.push(`${role}:${action.action}`);
        if (action.action === "expand") control.patch({ expanded: action.expanded });
        if (action.action === "pin") control.patch({ pinned: action.pinned });
      },
      relay: vi.fn(), changed, reducedMotion: () => true, log: vi.fn(),
    });
    surface.apply({ id: "surface-1", browserId: "global", mode: "pane" }, null, "http://127.0.0.1:1");
    const [bar, rail, , , divider] = views as [ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>];
    const send = (doc: ReturnType<typeof makeView>, message: unknown[], frame = doc.webContents.mainFrame) => doc.webContents.emit("console-message", { frame, message: JSON.stringify(message) });
    // 첫 배치: 선호 폭 560 — Console | 1px 경계(투명 7px 히트 영역) | (주소줄·레일·페이지) 가 한 번에 정해진다.
    expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 839, height: 900 });
    expect(divider.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(divider.setBounds).toHaveBeenLastCalledWith({ x: 836, y: 0, width: 7, height: 900 });
    expect(bar.setBounds).toHaveBeenLastCalledWith({ x: 840, y: 0, width: 560, height: 52 });
    expect(rail.setBounds).toHaveBeenLastCalledWith({ x: 840, y: 52, width: 54, height: 848 });
    expect(surface.target()?.page).toEqual({ x: 894, y: 52, width: 506, height: 848 });
    const dividerSend = (action: string, x: number, frame = divider.webContents.mainFrame) => divider.webContents.emit("console-message", { frame, message: JSON.stringify(["fleet-pane", action, x]) });
    dividerSend("start", 850); dividerSend("move", 750);
    expect(surface.target()?.page).toEqual({ x: 794, y: 52, width: 606, height: 848 });
    expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 739, height: 900 });
    // 다른 frame 메시지는 폭을 못 바꾸고, 끝난 끌기는 더 움직이지 않는다.
    dividerSend("move", 400, { url: divider.webContents.mainFrame.url });
    dividerSend("end", 750); dividerSend("move", 400);
    expect(surface.target()?.page.width).toBe(606);
    // 호버로 펼친 레일은 페이지를 덮고(레일 뷰만 커짐), 고정하면 페이지가 밀린다 — 모두 같은 틱의 setBounds 다.
    const foreignFrame = { url: pathToFileURL("/assets/browser-chrome/rail.html").href };
    send(rail, ["fleet-chrome", "rail", "expand", { expanded: true }], foreignFrame);
    expect(actions).toEqual([]);
    send(rail, ["fleet-chrome", "rail", "expand", { expanded: true }]);
    expect(actions).toEqual(["rail:expand"]);
    expect(rail.setBounds).toHaveBeenLastCalledWith({ x: 740, y: 52, width: 237, height: 848 });
    expect(surface.target()?.page).toEqual({ x: 794, y: 52, width: 606, height: 848 });
    send(rail, ["fleet-chrome", "rail", "pin", { pinned: true }]);
    expect(surface.target()?.page).toEqual({ x: 977, y: 52, width: 423, height: 848 });
    // 창이 좁아지면 Console 은 600 을 먼저 지키고 칸이 줄어든다 — 선호 폭(660)은 덮어쓰지 않는다.
    content = { ...content, width: 1100, height: 700 }; base.emit("resize");
    surface.refresh();
    expect(surface.target()?.page).toEqual({ x: 838, y: 52, width: 262, height: 648 });
    expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 600, height: 700 });
    // Console 을 확대하면 주소줄·레일 치수도 같은 배율로 따라가고 크롬 문서의 줌도 함께 바뀐다.
    zoomFactor = 1.25; surface.refresh();
    expect(bar.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 65 }));
    expect(bar.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.25);
    expect(surface.target()?.page.y).toBe(65);
    surface.dispose();
    expect(divider.webContents.close).toHaveBeenCalledOnce();
    expect(surface.target()).toBeNull();
    expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1100, height: 700 });
  });

  it("glides pane open (460ms spring) and asymmetric close (320ms glide) without resizing page width, and skips under reduced motion", () => {
    vi.useFakeTimers();
    try {
      let nowMs = 1_000;
      let reduce = false;
      const content = { x: 0, y: 0, width: 1400, height: 900 };
      const base = Object.assign(new EventEmitter(), { getContentBounds: () => content, isDestroyed: () => false,
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } });
      const makeView = () => {
        const mainFrame = { url: "" };
        const webContents = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false, close: vi.fn(), focus: vi.fn(), reload: vi.fn(), setZoomFactor: vi.fn(),
          setWindowOpenHandler: vi.fn(), loadURL: vi.fn(async (url: string) => { mainFrame.url = url; }),
          loadFile: vi.fn(async (file: string) => { mainFrame.url = pathToFileURL(file).href; }), executeJavaScript: vi.fn(async () => undefined) });
        return { webContents, setBounds: vi.fn(), setVisible: vi.fn(), setBackgroundColor: vi.fn() };
      };
      const consoleView = makeView();
      const stack = createDesktopViewStack(base as never, consoleView as never);
      const shell = createDesktopShellWindow(base as never, consoleView as never, stack);
      const views: ReturnType<typeof makeView>[] = [];
      const surface = createBrowserSurface({
        main: () => shell,
        createChromeView: () => { const created = makeView(); views.push(created); return created as never; },
        createDividerView: () => { const created = makeView(); views.push(created); return created as never; },
        createWindow: () => { throw new Error("window mode is not part of this contract"); },
        chromeDir: "/assets/browser-chrome", program: () => "", colors: () => null, lang: "en", platform: "darwin", scaleFactor: () => 1, zoom: () => 1,
        act: vi.fn(), relay: vi.fn(), changed: vi.fn(), reducedMotion: () => reduce, now: () => nowMs, log: vi.fn(),
      });

      surface.apply({ id: "surface-motion", browserId: "global", mode: "pane" }, null, "http://127.0.0.1:1");
      const [bar, , , , divider] = views as [ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>];
      // Ready bar so closing state pushes shellClosing: true
      bar.webContents.emit("console-message", { frame: bar.webContents.mainFrame, message: JSON.stringify(["fleet-chrome", "bar", "ready", {}]) });
      // Frame 0 claims settled Console width once without 60fps reflow and starts page 10px down (no width resize)
      expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 839, height: 900 });
      expect(surface.target()?.page.width).toBe(506);
      expect(surface.target()?.page.y).toBe(62);

      nowMs += 160;
      vi.advanceTimersByTime(160);
      const midOpenY = surface.target()!.page.y;
      expect(midOpenY).toBeGreaterThanOrEqual(52);
      expect(midOpenY).toBeLessThan(62);
      expect(surface.target()?.page.width).toBe(506);

      nowMs += 320;
      vi.advanceTimersByTime(320);
      expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 839, height: 900 });
      expect(surface.target()?.page).toEqual({ x: 894, y: 52, width: 506, height: 848 });

      // Asymmetric close (320ms) restores Console width once underneath while gliding the pane out
      surface.apply(null, null, null);
      expect(divider.webContents.close).not.toHaveBeenCalled();
      expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1400, height: 900 });
      expect(bar.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"shellClosing":true'));
      nowMs += 160;
      vi.advanceTimersByTime(160);
      expect(divider.webContents.close).not.toHaveBeenCalled();
      expect(surface.target()!.page.x).toBeGreaterThan(894);
      expect(surface.target()?.page.width).toBe(506);

      nowMs += 180;
      vi.advanceTimersByTime(180);
      expect(divider.webContents.close).toHaveBeenCalledOnce();
      expect(surface.target()).toBeNull();
      expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1400, height: 900 });

      // Reduced motion completes open and close immediately
      reduce = true;
      surface.apply({ id: "surface-rm", browserId: "global", mode: "pane" }, null, "http://127.0.0.1:1");
      expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 839, height: 900 });
      surface.apply(null, null, null);
      expect(surface.target()).toBeNull();
      expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1400, height: 900 });
    } finally {
      vi.useRealTimers();
    }
  });
  // 셸 게이트: 페이지가 연 창을 새 탭으로 받을지 같은 뷰에서 열지(또는 열지 않을지)를 핸들러에서 동기로 정한다.
  it("opens page-opened windows as tabs only when the Console takes them, and keeps the same-view fallback and the address gate", async () => {
    let lifetime: DesktopBrowserSnapshot = { generation: 1, epoch: "gate", views: [view("view-a")], commands: [], popups: true };
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const relays: DesktopBrowserRelay[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const { pathname } = new URL(String(input));
      if (pathname === DESKTOP_BROWSER_RELAY_PATH) { relays.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
      if (pathname === DESKTOP_BROWSER_PATH) return Response.json(lifetime);
      if (pathname === DESKTOP_BROWSER_EVENTS_PATH) return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { streams.push(controller); controller.enqueue(new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`)); } }));
      return new Response(null, { status: 404 });
    });
    const created: Array<{ partition: string; closed: boolean; commands: string[]; contents: EventEmitter; openHandler?: OpenHandler; loaded?: string[] }> = [];
    const mainHost = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 2, reclaimFocus: vi.fn() } satisfies PageHost;
    const views = createDesktopBrowserViews({
      shell: () => mainHost, consoleContents: () => null,
      surface: { apply: vi.fn(), target: () => null, lastPage: () => null, inputLocked: () => false, refresh: vi.fn(), dispose: vi.fn() },
      createView: (partition) => fakeView(partition, created), product: () => "Chrome/150.0", userAgent: () => "Mozilla/5.0 Chrome/150.0", fetch: fetch as typeof globalThis.fetch,
    });
    await views.start(REMOTE);
    await vi.waitFor(() => expect(created[0]?.openHandler).toBeDefined());
    const open = created[0]!.openHandler!;
    const loaded = created[0]!.loaded!;
    await vi.waitFor(() => expect(loaded).toEqual(["about:blank"]));
    loaded.length = 0;
    const tab = { url: "https://links.example/next", disposition: "foreground-tab", features: "", frameName: "" };
    const shiftClick = { ...tab, disposition: "new-window" };
    const popup = { ...tab, disposition: "new-window", features: "width=400,height=300" };
    const update = async (next: Partial<DesktopBrowserSnapshot>, expectOpens: () => void) => {
      lifetime = { ...lifetime, ...next, generation: lifetime.generation + 1 };
      streams.at(-1)!.enqueue(new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`));
      await vi.waitFor(expectOpens);
    };

    // 옛 Console(탭형 열기 표시 없음): 팝업만 새 창으로 받고, 탭형 열기와 Shift 클릭(new-window 이지만 기능이 비어 있다)은 같은 뷰에서 연다.
    expect(open(popup).action).toBe("allow");
    expect(open(tab).action).toBe("deny");
    expect(open(shiftClick).action).toBe("deny");
    expect(loaded).toEqual([tab.url, tab.url]);
    // 받을 만하지 않은 주소(data:)는 받는 Console 이든 아니든 새 탭으로도 같은 뷰로도 열지 않는다. 같은 출처 blob: 은 같은 뷰로 열린다.
    expect(open({ ...tab, url: "data:text/html,<b>x</b>" }).action).toBe("deny");
    expect(open({ ...tab, url: "blob:https://opener.example/1234" }).action).toBe("deny");
    expect(open({ ...tab, url: "blob:https://elsewhere.example/1234" }).action).toBe("deny");
    expect(loaded).toEqual([tab.url, tab.url, "blob:https://opener.example/1234"]);

    // 새 Console: 탭형 열기와 Shift 클릭도 새 탭으로 받는다. 그 뷰의 스페이스가 가득 찼다고 알리면 같은 뷰에서 연다(상한 초과).
    await update({ tabOpens: { full: [] } }, () => expect(open(tab).action).toBe("allow"));
    expect(open(shiftClick).action).toBe("allow");
    expect(open({ ...tab, url: "data:text/html,x" }).action).toBe("deny");
    // 수정키 클릭은 Chromium 이 webContents 를 만들지 않는다 — 셸이 직접 뷰를 만들어 알린다(백그라운드는 표시). 그 뷰는 about:blank 에 서고
    // Console 이 준비한 뒤 주소로 보낸다. POST 열기는 붙잡지 않고 셸이 본문째 적재하며 Console 은 이동 없이 등록만 한다.
    const popups = () => relays.flatMap((relay) => relay.popups ?? []);
    (open({ ...tab, disposition: "background-tab" }).createWindow as (options: object) => unknown)({});
    await vi.waitFor(() => expect(popups()).toEqual([{ viewId: expect.stringMatching(/^popup-/u), openerViewId: "view-a", url: tab.url, background: true }]));
    expect(created).toHaveLength(2);
    expect(created[1]!.loaded).toEqual(["about:blank"]);
    const post = { data: [{ type: "rawData", bytes: Buffer.from("k=v") }], contentType: "application/x-www-form-urlencoded" };
    (open({ ...tab, postBody: post }).createWindow as (options: object) => unknown)({});
    await vi.waitFor(() => expect(popups()).toHaveLength(2));
    expect(popups()[1]).toEqual({ viewId: expect.stringMatching(/^popup-/u), openerViewId: "view-a", url: tab.url, loaded: true });
    expect(created[2]!.loaded).toEqual(["about:blank", tab.url]);
    // 창 기능 팝업은 그 플래그를 함께 싣는다 — Console 이 닫은 뒤 선택에서 탭형 열기와 구별한다. 탭형(백그라운드·POST)에는 없다.
    (open(popup).createWindow as (options: object) => unknown)({});
    await vi.waitFor(() => expect(popups()).toHaveLength(3));
    expect(popups()[2]).toEqual({ viewId: expect.stringMatching(/^popup-/u), openerViewId: "view-a", url: tab.url, windowPopup: true });
    await update({ tabOpens: { full: ["view-a"] } }, () => expect(open(tab).action).toBe("deny"));
    expect(open(popup).action).toBe("allow");
    expect(loaded.at(-1)).toBe(tab.url);
    views.stop();
  });

  it("rebuilds views and runs commands from a restarted Console on the same origin", async () => {
    let lifetime: DesktopBrowserSnapshot = {
      generation: 58, epoch: "before", views: [view("view-old")],
      commands: [{ id: 1, viewId: "view-old", method: "Page.navigate", params: {} }],
    };
    const relays: DesktopBrowserRelay[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const { pathname } = new URL(String(input));
      if (pathname === DESKTOP_BROWSER_RELAY_PATH) { relays.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
      if (pathname === DESKTOP_BROWSER_PATH) return Response.json(lifetime);
      if (pathname === DESKTOP_BROWSER_EVENTS_PATH) {
        const frame = new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { streams.push(controller); controller.enqueue(frame); } }));
      }
      return new Response(null, { status: 404 });
    });
    const created: Array<{ partition: string; closed: boolean; commands: string[]; contents: EventEmitter }> = [];
    const mainHost = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 2, reclaimFocus: vi.fn() } satisfies PageHost;
    const childHost = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 1000, height: 760 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 2, reclaimFocus: vi.fn() } satisfies PageHost;
    let target: { host: PageHost; page: { x: number; y: number; width: number; height: number } } | null = null;
    const surface = { apply: vi.fn(), target: () => target, lastPage: () => null, inputLocked: () => false, refresh: vi.fn(), dispose: vi.fn() };
    const views = createDesktopBrowserViews({
      shell: () => mainHost,
      consoleContents: () => null,
      surface,
      createView: (partition) => fakeView(partition, created),
      product: () => "Chrome/150.0",
      userAgent: () => "Mozilla/5.0 Chrome/150.0",
      fetch: fetch as typeof globalThis.fetch,
    });

    await views.start(REMOTE);
    await vi.waitFor(() => expect(created[0]?.commands).toContain("Page.navigate"));

    // 재기동: 옛 스트림이 끝나고, 같은 origin 의 새 프로세스가 generation 1·명령 id 1 로 다시 센다.
    lifetime = { generation: 1, epoch: "after", views: [view("view-new")], commands: [{ id: 1, viewId: "view-new", method: "Runtime.evaluate", params: {} }] };
    const hellosBefore = relays.filter((relay) => relay.hello).length;
    streams[0]!.close();

    await vi.waitFor(() => {
      expect(created).toHaveLength(2);
      expect(created[1]?.commands).toContain("Runtime.evaluate");
    }, { timeout: 5_000 });
    expect(created[0]?.closed).toBe(true);
    // 새 프로세스는 이 셸을 모른다 — 부착과 자기소개가 그쪽으로 다시 간다.
    await vi.waitFor(() => expect(relays.some((relay) => relay.attached?.includes("view-new"))).toBe(true));
    expect(relays.filter((relay) => relay.hello).length).toBe(hellosBefore + 1);
    // 옛 프로세스의 명령 1 이 뷰와 함께 거부돼도 그 답은 같은 id 를 쓰는 새 프로세스의 명령 1 을 풀지 않는다.
    await vi.waitFor(() => expect(relays.flatMap((relay) => relay.results ?? []).some((result) => result.id === 1 && result.error === undefined)).toBe(true));
    expect(relays.flatMap((relay) => relay.results ?? []).filter((result) => result.error !== undefined)).toEqual([]);
    // 표면이 열리면(독립 창) 표시 탭의 페이지가 그 창의 페이지 자리에 서고, 자리가 바뀌면 같은 틱에 따라온다.
    lifetime = { ...lifetime, generation: 2, surface: { id: "surface-one", browserId: "op-1", mode: "window" }, views: [{ ...view("view-new"), visible: true }] };
    target = { host: childHost, page: { x: 54, y: 52, width: 946, height: 708 } };
    const update = () => streams.at(-1)!.enqueue(new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`));
    update();
    await vi.waitFor(() => expect(childHost.present).toHaveBeenCalled());
    const native = childHost.present.mock.calls[0]![0];
    expect(native.setBounds).toHaveBeenLastCalledWith({ x: 54, y: 52, width: 946, height: 708 });
    target = { host: childHost, page: { x: 54, y: 52, width: 1146, height: 848 } };
    views.places();
    expect(native.setBounds).toHaveBeenLastCalledWith({ x: 54, y: 52, width: 1146, height: 848 });
    expect(created).toHaveLength(2);
    expect(created[1]?.closed).toBe(false);
    // 표면이 사라지면(창을 접거나 닫음) 뷰는 닫히지 않고 메인 창 뒤에 주차된다.
    target = null;
    views.places();
    expect(childHost.remove).toHaveBeenLastCalledWith(native);
    expect(mainHost.park).toHaveBeenLastCalledWith(native);
    expect(created[1]?.closed).toBe(false);
    views.stop();
    expect(created[1]?.closed).toBe(true);
    expect(surface.dispose).toHaveBeenCalled();
  });

  it("parks a hidden native view on one pixel of the window's bottom-right corner so it cannot take input elsewhere", () => {
    const content = { x: 0, y: 0, width: 1200, height: 800 };
    const bounds = parkedNativeBounds({ width: 900, height: 700 }, content);
    expect(bounds.width).toBe(900);
    expect(bounds.height).toBe(700);
    // 창과 겹치는 부분은 오른쪽 아래 한 픽셀뿐이다 — 왼쪽 위(캡션 단추) 쪽에는 걸치지 않는다.
    expect(Math.max(0, Math.min(content.width, bounds.x + bounds.width) - Math.max(0, bounds.x))).toBe(1);
    expect(Math.max(0, Math.min(content.height, bounds.y + bounds.height) - Math.max(0, bounds.y))).toBe(1);
    expect(bounds.x).toBe(content.width - 1);
    expect(bounds.y).toBe(content.height - 1);
    // 창보다 큰 viewport 도 크기는 content 안으로 줄고, 겹침은 여전히 한 픽셀이다.
    const clamped = parkedNativeBounds({ width: 5000, height: 5000 }, content);
    expect([clamped.width, clamped.height]).toEqual([1200, 800]);
    expect([clamped.x, clamped.y]).toEqual([1199, 799]);
  });
});

describe("managed browser auth and on-demand frames", () => {
  const ORIGIN = "http://127.0.0.1:4310";

  it("sends the lock token and access path, captures only while watched, and keeps a single in-flight frame", async () => {
    let lifetime: DesktopBrowserSnapshot = { generation: 1, epoch: "life", views: [view("view-1")], commands: [{ id: 1, viewId: "view-1", method: "Runtime.evaluate", params: {} }] };
    const relays: DesktopBrowserRelay[] = [];
    const frames: { body: Buffer; headers: Headers }[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const headerOf = (init?: RequestInit): Headers => new Headers(init?.headers);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === DESKTOP_BROWSER_RELAY_PATH) { relays.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
      if (url.pathname === DESKTOP_BROWSER_FRAME_PATH) {
        frames.push({ body: Buffer.from(init?.body as Uint8Array), headers: headerOf(init) });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === DESKTOP_BROWSER_PATH || url.pathname === DESKTOP_BROWSER_EVENTS_PATH) {
        expect(headerOf(init).get("authorization")).toBe("Bearer lock-token");
        expect(headerOf(init).get(DESKTOP_BROWSER_OWNER_HEADER)).toBe("owner-1");
        if (url.pathname === DESKTOP_BROWSER_PATH) return Response.json(lifetime);
        const frame = new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { streams.push(controller); controller.enqueue(frame); } }));
      }
      return new Response(null, { status: 404 });
    });
    const created: Array<{ partition: string; closed: boolean; commands: string[]; contents: EventEmitter; frameSubs: { begin: number; end: number } }> = [];
    const shell = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 1, reclaimFocus: vi.fn() } satisfies PageHost;
    const nativeViews: WebContentsView[] = [];
    let releaseCapture: (() => void) | null = null;
    let captureResult: Buffer | null = Buffer.from("frame-1");
    const captures: Buffer[] = [];
    const captureProfiles: number[] = [];
    let clock = 5_000;
    const pending: { ms: number; cancelled: boolean }[] = [];
    const publish = (next: DesktopBrowserSnapshot): void => {
      lifetime = next;
      streams.at(-1)!.enqueue(new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`));
    };
    const views = createDesktopBrowserViews({
      shell: () => shell,
      consoleContents: () => null,
      surface: { apply: vi.fn(), target: () => null, lastPage: () => null, inputLocked: () => false, refresh: vi.fn(), dispose: vi.fn() },
      createView: (partition) => { const native = fakeView(partition, created); nativeViews.push(native); return native; },
      product: () => "Chrome/150.0",
      userAgent: () => "Mozilla/5.0 Chrome/150.0",
      auth: () => ({ token: "lock-token", ownerId: "owner-1" }),
      hostLabel: () => "desk",
      platform: "darwin",
      accessPath: "wsl",
      captureViewerFrame: (_view, options) => new Promise((resolve) => {
        const jpeg = captureResult ?? Buffer.from("empty");
        captures.push(jpeg);
        captureProfiles.push(options.profile.quality);
        releaseCapture = () => resolve(captureResult === null ? null : { jpeg, width: 320, height: 180, cssWidth: 500, cssHeight: 850 });
      }),
      now: () => clock,
      schedule: (cb, ms) => {
        const handle = { ms, cancelled: false };
        pending.push(handle);
        if (ms === 0) queueMicrotask(() => { if (!handle.cancelled) cb(); });
        return handle;
      },
      cancel: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
      fetch: fetch as typeof globalThis.fetch,
    });

    await views.start(ORIGIN);
    await vi.waitFor(() => expect(relays.flatMap((relay) => relay.results ?? []).some((result) => result.id === 1)).toBe(true));
    // 집 콘솔은 http다. 가드 필터가 https만 보면 SSE에 뷰 출처가 붙지 않는다.
    const marked = created[0] as typeof created[0] & { filter: { urls: readonly string[] } | null; listener: ((details: { url: string; requestHeaders: Record<string, string>; webContentsId?: number }, callback: (response: { requestHeaders?: Record<string, string> }) => void) => void) | null };
    const headers: Record<string, string> = { [DESKTOP_BROWSER_VIEW_HEADER]: "spoofed" };
    const delivered = deliverViewRequest(marked.filter, marked.listener, { url: `${ORIGIN}/api/v1/objectives/events`, requestHeaders: headers, webContentsId: 41 });
    expect(delivered.called).toBe(true);
    expect(delivered.requestHeaders?.[DESKTOP_BROWSER_VIEW_HEADER]).toBe("view-1");
    expect(captures).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect(relays.some((relay) => relay.hello?.accessPath === "wsl" && relay.hello.hostLabel === "desk" && relay.hello.platform === "darwin")).toBe(true);
    expect(headerOf(fetch.mock.calls.find((call) => String(call[0]).includes(DESKTOP_BROWSER_RELAY_PATH))?.[1]).get("authorization")).toBe("Bearer lock-token");

    publish({ ...lifetime, generation: 2, watchedViewIds: ["view-1"] });
    await vi.waitFor(() => expect(captures).toHaveLength(1));
    // 기본 화질 프로필은 balanced(JPEG 72)다.
    expect(captureProfiles[0]).toBe(72);
    expect(created[0]!.frameSubs.begin).toBe(1);
    expect(frames).toHaveLength(0);
    // 유휴 폴링 50ms(활성 최소 33ms) — 기존 250ms 상한을 대체한다.
    expect(pending.some((timer) => timer.ms >= 50)).toBe(true);
    const page = created[0]!.contents;
    page.emit("did-navigate");
    page.emit("did-stop-loading");
    page.emit("did-navigate-in-page");
    page.emit("dom-ready");
    await Promise.resolve();
    expect(captures).toHaveLength(1);

    clock += 300;
    const finishFirst = releaseCapture!;
    captureResult = Buffer.from("frame-2");
    finishFirst();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    await vi.waitFor(() => expect(captures).toHaveLength(2));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.body.equals(Buffer.from("frame-1"))).toBe(true);
    expect(frames[0]!.headers.get(DESKTOP_BROWSER_VIEW_HEADER)).toBe("view-1");
    expect(frames[0]!.headers.get("content-type")).toBe("image/jpeg");
    // 프레임의 CSS 메타는 뷰 bounds 가 아니라 페이지의 실제 레이아웃이다 — 원격 좌표가 이 값을 쓴다.
    expect(frames[0]!.headers.get("x-fleet-frame-css-width")).toBe("500");
    expect(frames[0]!.headers.get("x-fleet-frame-css-height")).toBe("850");

    const finishSecond = releaseCapture!;
    captureResult = Buffer.from("frame-2");
    finishSecond();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1]!.body.equals(Buffer.from("frame-2"))).toBe(true);
    expect(captures).toHaveLength(2);

    // 시청자가 고른 화질이 다음 캡처에 바로 반영된다.
    publish({ ...lifetime, generation: 3, watchedViewIds: ["view-1"], viewerCapture: "high" });
    clock += 300;
    page.emit("did-navigate");
    await vi.waitFor(() => expect(captures).toHaveLength(3));
    expect(captureProfiles.at(-1)).toBe(85);
    releaseCapture!();
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toHaveLength(2);

    publish({ ...lifetime, generation: 4, watchedViewIds: [] });
    await vi.waitFor(() => expect(created[0]!.frameSubs.end).toBe(1));
    const capturedAtStop = captures.length;
    page.emit("did-navigate");
    page.emit("dom-ready");
    clock += 1_000;
    await Promise.resolve();
    expect(captures).toHaveLength(capturedAtStop);
    expect(created[0]!.closed).toBe(false);

    // 보던 페이지가 스스로 닫히면(window.close) 뷰가 webContents 를 먼저 잃은 채 디버거 detach 가 온다.
    // 메인 프로세스 예외 없이 정리를 끝내고 Console 에 detached 를 알려야 한다.
    publish({ ...lifetime, generation: 5, watchedViewIds: ["view-1"] });
    await vi.waitFor(() => expect(created[0]!.frameSubs.begin).toBe(2));
    const pageDebugger = (created[0]!.contents as EventEmitter & { debugger: EventEmitter }).debugger;
    (nativeViews[0] as unknown as { webContents?: unknown }).webContents = undefined;
    expect(() => pageDebugger.emit("detach", {}, "target closed")).not.toThrow();
    expect(shell.remove).toHaveBeenCalledWith(nativeViews[0]);
    await vi.waitFor(() => expect(relays.flatMap((relay) => relay.detached ?? [])).toContain("view-1"));
    views.stop();
    expect(created[0]!.frameSubs).toEqual({ begin: 2, end: 1 });
  });

  it("streams viewer frames from the page screencast instead of polling captures", async () => {
    let lifetime: DesktopBrowserSnapshot = { generation: 1, epoch: "life", views: [view("view-1")], commands: [] };
    const frames: { body: Buffer; headers: Headers }[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const headerOf = (init?: RequestInit): Headers => new Headers(init?.headers);
    let holdFramePost = false;
    let releaseFramePost: (() => void) | null = null;
    let failFramePost = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === DESKTOP_BROWSER_RELAY_PATH) return new Response(null, { status: 204 });
      if (url.pathname === DESKTOP_BROWSER_FRAME_PATH) {
        const body = Buffer.from(init?.body as Uint8Array);
        const headers = headerOf(init);
        // 업로드가 느린 회선을 흉내 낸다 — 응답 전에는 frames 에 남기지 않는다.
        if (holdFramePost) { holdFramePost = false; await new Promise<void>((resolve) => { releaseFramePost = resolve; }); }
        if (failFramePost) { failFramePost = false; return new Response(null, { status: 500 }); }
        frames.push({ body, headers });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === DESKTOP_BROWSER_PATH) return Response.json(lifetime);
      if (url.pathname === DESKTOP_BROWSER_EVENTS_PATH) {
        const frame = new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { streams.push(controller); controller.enqueue(frame); } }));
      }
      return new Response(null, { status: 404 });
    });
    const created: Array<{ partition: string; closed: boolean; commands: string[]; sent: Array<{ method: string; params: Record<string, unknown> }>; contents: EventEmitter; frameSubs: { begin: number; end: number } }> = [];
    const shell = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 1, reclaimFocus: vi.fn() } satisfies PageHost;
    let releaseCapture: (() => void) | null = null;
    const captures: Buffer[] = [];
    let captureSeq = 0;
    let clock = 5_000;
    const publish = (next: DesktopBrowserSnapshot): void => {
      lifetime = next;
      streams.at(-1)!.enqueue(new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`));
    };
    const views = createDesktopBrowserViews({
      shell: () => shell,
      consoleContents: () => null,
      surface: { apply: vi.fn(), target: () => null, lastPage: () => null, inputLocked: () => false, refresh: vi.fn(), dispose: vi.fn() },
      createView: (partition) => fakeView(partition, created),
      product: () => "Chrome/150.0",
      userAgent: () => "Mozilla/5.0 Chrome/150.0",
      auth: () => ({ token: "lock-token", ownerId: "owner-1" }),
      hostLabel: () => "desk",
      platform: "darwin",
      accessPath: "wsl",
      captureViewerFrame: () => new Promise((resolve) => {
        captureSeq += 1;
        // 매번 다른 장 — 같은 JPEG 는 전송 억제되므로 폴백이 실제로 올라갔는지 이 본문으로 구분한다.
        const jpeg = Buffer.from(`fallback-${captureSeq}`);
        captures.push(jpeg);
        releaseCapture = () => resolve({ jpeg, width: 320, height: 180, cssWidth: 506, cssHeight: 848 });
      }),
      now: () => clock,
      schedule: (cb, ms) => {
        const handle = { ms, cancelled: false };
        if (ms === 0) queueMicrotask(() => { if (!handle.cancelled) cb(); });
        return handle;
      },
      cancel: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
      fetch: fetch as typeof globalThis.fetch,
    });
    const screencastParams = (): Record<string, unknown>[] => created[0]!.sent.filter((command) => command.method === "Page.startScreencast").map((command) => command.params);
    try {
      await views.start(ORIGIN);
      await vi.waitFor(() => expect(created).toHaveLength(1));
      publish({ ...lifetime, generation: 2, watchedViewIds: ["view-1"] });
      // 감시가 시작되면 스크린캐스트를 걸고, 첫 장이 오기 전에는 폴백 캡처가 한 장을 만든다.
      await vi.waitFor(() => expect(created[0]!.commands).toContain("Page.startScreencast"));
      expect(screencastParams()[0]).toMatchObject({ format: "jpeg", quality: 72, maxWidth: 1280, everyNthFrame: 1 });
      await vi.waitFor(() => expect(captures).toHaveLength(1));
      releaseCapture!();
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]!.body.equals(Buffer.from("fallback-1"))).toBe(true);

      // 스크린캐스트 프레임은 디코드 없이 그대로 올라가고, CSS 크기는 메타데이터의 장치 크기다.
      const page = created[0]!.contents as EventEmitter & { debugger: EventEmitter };
      const streamed = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x01]);
      const emitFrame = (jpeg: Buffer): void => {
        clock += 100;
        page.debugger.emit("message", {}, "Page.screencastFrame", { data: jpeg.toString("base64"), metadata: { deviceWidth: 506, deviceHeight: 848 }, sessionId: 3 });
      };
      emitFrame(streamed);
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[1]!.body.equals(streamed)).toBe(true);
      expect(frames[1]!.headers.get(DESKTOP_BROWSER_FRAME_CSS_WIDTH_HEADER)).toBe("506");
      expect(frames[1]!.headers.get(DESKTOP_BROWSER_FRAME_CSS_HEIGHT_HEADER)).toBe("848");
      expect(frames[1]!.headers.get(DESKTOP_BROWSER_FRAME_WIDTH_HEADER)).toBe("506");
      expect(created[0]!.commands).toContain("Page.screencastFrameAck");
      // 스크린캐스트가 밀어 주는 동안 폴링 캡처는 더 돌지 않는다.
      expect(captures).toHaveLength(1);

      // 같은 JPEG 는 두 번 올리지 않는다.
      emitFrame(streamed);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frames).toHaveLength(2);

      // 업로드가 간격보다 오래 걸려도 한 건만 띄우고, 그 사이 장은 최신 한 장으로 합친다(순서 보존).
      const first = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x02]);
      const latest = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x03]);
      const dropped = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x04]);
      holdFramePost = true;
      emitFrame(first);
      await vi.waitFor(() => expect(releaseFramePost).not.toBeNull());
      emitFrame(dropped);
      emitFrame(latest);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frames).toHaveLength(2);
      clock += 100;
      releaseFramePost!();
      await vi.waitFor(() => expect(frames).toHaveLength(4));
      expect(frames[2]!.body.equals(first)).toBe(true);
      expect(frames[3]!.body.equals(latest)).toBe(true);

      // 화질이 바뀌면 감시 중인 스크린캐스트를 새 프로필로 다시 건다.
      publish({ ...lifetime, generation: 3, watchedViewIds: ["view-1"], viewerCapture: "high" });
      await vi.waitFor(() => expect(screencastParams()).toHaveLength(2));
      expect(screencastParams()[1]).toMatchObject({ quality: 85, maxWidth: 1920 });
      expect(created[0]!.commands).toContain("Page.stopScreencast");

      // 첫 장 업로드가 실패하면 폴링 캡처가 다시 맡는다 — 정지한 페이지가 빈 화면으로 남지 않는다.
      failFramePost = true;
      emitFrame(dropped);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frames).toHaveLength(4);
      page.emit("did-navigate");
      clock += 100;
      await vi.waitFor(() => expect(captures).toHaveLength(2));
      releaseCapture!();
      await vi.waitFor(() => expect(frames).toHaveLength(5));

      // 폴백 업로드가 느릴 때 그 사이 온 스크린캐스트 장은 기다렸다가 뒤에 올라간다 — 옛 장이 새 장을 덮지 않는다.
      page.emit("did-navigate");
      clock += 100;
      await vi.waitFor(() => expect(captures).toHaveLength(3));
      holdFramePost = true;
      releaseFramePost = null;
      releaseCapture!();
      await vi.waitFor(() => expect(releaseFramePost).not.toBeNull());
      const afterFallback = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x05]);
      emitFrame(afterFallback);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frames).toHaveLength(5);
      clock += 100;
      releaseFramePost!();
      await vi.waitFor(() => expect(frames).toHaveLength(7));
      expect(frames[5]!.body.equals(Buffer.from("fallback-3"))).toBe(true);
      expect(frames[6]!.body.equals(afterFallback)).toBe(true);

      // 감시가 끝나면 스크린캐스트도 멈춘다.
      publish({ ...lifetime, generation: 4, watchedViewIds: [] });
      await vi.waitFor(() => expect(created[0]!.commands.filter((method) => method === "Page.stopScreencast")).toHaveLength(2));
    } finally {
      views.stop();
    }
  });

  it("keeps view bounds on the surface page and leaves the logical viewport to the console emulation", async () => {
    const ORIGIN = "http://127.0.0.1:4310";
    let lifetime: DesktopBrowserSnapshot = { generation: 1, epoch: "life", views: [{ ...view("shown"), visible: true }, view("parked")], commands: [] };
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === DESKTOP_BROWSER_RELAY_PATH) return new Response(null, { status: 204 });
      if (url.pathname === DESKTOP_BROWSER_PATH) return Response.json(lifetime);
      if (url.pathname === DESKTOP_BROWSER_EVENTS_PATH) {
        const frame = new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { streams.push(controller); controller.enqueue(frame); } }));
      }
      return new Response(null, { status: 404 });
    });
    const created: Array<{ bounds: ReturnType<typeof vi.fn> }> = [];
    const shell = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 1, reclaimFocus: vi.fn() } satisfies PageHost;
    const page = { x: 10, y: 20, width: 900, height: 700 };
    const publish = (next: DesktopBrowserSnapshot): void => {
      lifetime = next;
      streams.at(-1)!.enqueue(new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`));
    };
    const chrome = (setBy: "user" | "agent") => ({
      browserId: "global", spaces: [], tabs: [], activeTabId: null,
      viewport: { preset: "responsive" as const, width: 500, height: 850, setBy },
      driving: false, profile: null, defaultProfile: null, available: true, reason: null as "desktop_required" | "shared" | null,
    });
    const views = createDesktopBrowserViews({
      shell: () => shell,
      consoleContents: () => null,
      surface: { apply: vi.fn(), target: () => ({ host: shell, page }), lastPage: () => null, inputLocked: () => false, refresh: vi.fn(), dispose: vi.fn() },
      createView: (partition) => fakeView(partition, created as never),
      product: () => "Chrome/150.0",
      userAgent: () => "Mozilla/5.0 Chrome/150.0",
      fetch: fetch as typeof globalThis.fetch,
    });
    await views.start(ORIGIN);
    await vi.waitFor(() => { if (created.length < 2) throw new Error("waiting"); });
    publish({ ...lifetime, generation: 2, chrome: chrome("user") });
    // 시청 측 크기는 Console 이 뷰포트 에뮬레이션으로 세운다 — 셸은 뷰 bounds 를 바꾸지 않는다.
    await vi.waitFor(() => expect(created[0]!.bounds.mock.calls.at(-1)?.[0]).toEqual(page));
    expect(created[1]!.bounds.mock.calls.at(-1)?.[0]).toEqual({ x: 899, y: 699, width: 900, height: 700 });
    publish({ ...lifetime, generation: 3, chrome: chrome("agent") });
    await vi.waitFor(() => expect(created[0]!.bounds.mock.calls.at(-1)?.[0]).toEqual(page));
    expect(created[1]!.bounds.mock.calls.at(-1)?.[0]).toEqual({ x: 899, y: 699, width: 900, height: 700 });
    views.stop();
  });
});

describe("http loopback view session guard", () => {
  const ORIGIN = "http://127.0.0.1:4310";
  const kept = "fleet_console_pairing_4310=own-pairing; fleet_console_session_4310=own-session; theme=light";

  it("strips sibling cookies before the origin marker and still marks http loopback SSE", async () => {
    const cookie = [
      "fleet_console_pairing_4311=sibling-pairing",
      "fleet_console_session_4311=sibling-session",
      "fleet_console_pairing_4310=own-pairing",
      "fleet_console_session_4310=own-session",
      "theme=light",
    ].join("; ");
    const sse = `${ORIGIN}/api/v1/objectives/events`;
    const record: { filter: { urls: readonly string[] } | null; listener: ViewRequestListener | null } = { filter: null, listener: null };
    let atRegister: { cookie?: string; view?: string } | null = null;
    const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const { pathname } = new URL(String(input));
      if (pathname === DESKTOP_BROWSER_RELAY_PATH) return new Response(null, { status: 204 });
      if (pathname === DESKTOP_BROWSER_PATH) return Response.json({ generation: 1, epoch: "life", views: [view("view-1")], commands: [] });
      if (pathname === DESKTOP_BROWSER_EVENTS_PATH) return new Response(new ReadableStream<Uint8Array>({ start() {} }));
      return new Response(null, { status: 404 });
    });
    const shell = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 1, reclaimFocus: vi.fn() } satisfies PageHost;
    const views = createDesktopBrowserViews({
      shell: () => shell,
      consoleContents: () => null,
      surface: { apply: vi.fn(), target: () => null, lastPage: () => null, inputLocked: () => false, refresh: vi.fn(), dispose: vi.fn() },
      createView: () => {
        const contents = Object.assign(new EventEmitter(), {
          id: 41,
          session: {
            webRequest: {
              onBeforeSendHeaders(filter: { urls: readonly string[] }, listener: ViewRequestListener) {
                record.filter = filter;
                record.listener = listener;
                // 등록 즉시 요청을 흘려 설치 순서를 본다. 표식이 먼저면 view가 여기서 view-1이 된다.
                const delivered = deliverViewRequest(filter, listener, {
                  url: sse,
                  requestHeaders: { Cookie: cookie, [DESKTOP_BROWSER_VIEW_HEADER]: "spoofed" },
                  webContentsId: 41,
                });
                atRegister = { cookie: delivered.requestHeaders?.Cookie, view: delivered.requestHeaders?.[DESKTOP_BROWSER_VIEW_HEADER] };
              },
              onHeadersReceived() {},
            },
          },
          debugger: Object.assign(new EventEmitter(), { attach() {}, detach() {}, isAttached: () => true, sendCommand: () => Promise.resolve({}) }),
          setWindowOpenHandler() {},
          loadURL: async () => {},
          isFocused: () => false,
          isDestroyed: () => false,
          close() {},
        });
        return { webContents: contents, setBorderRadius() {}, setBounds: vi.fn(), setVisible() {} } as unknown as WebContentsView;
      },
      product: () => "Chrome/150.0",
      userAgent: () => "Mozilla/5.0 Chrome/150.0",
      fetch: fetch as typeof globalThis.fetch,
    });

    await views.start(ORIGIN);
    expect(atRegister).toEqual({ cookie: kept, view: "spoofed" });
    const marked = deliverViewRequest(record.filter, record.listener, {
      url: sse,
      requestHeaders: { Cookie: cookie, [DESKTOP_BROWSER_VIEW_HEADER]: "spoofed" },
      webContentsId: 41,
    });
    expect(marked.called).toBe(true);
    expect(marked.requestHeaders?.[DESKTOP_BROWSER_VIEW_HEADER]).toBe("view-1");
    expect(marked.requestHeaders?.Cookie).toBe(kept);
    views.stop();
  });
});
