import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readChromeHistory } from "../src/chrome-history.js";
import { createBrowserHistoryStorage } from "../src/browser-history-storage.js";
import { DESKTOP_BROWSER_EVENT, DESKTOP_BROWSER_EVENTS_PATH, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_RELAY_PATH, type DesktopBrowserRelay, type DesktopBrowserSnapshot } from "@fleet-console/protocol/desktop";
import type { WebContentsView } from "electron";
import { createDesktopShellWindow, createDesktopViewStack, parkedNativeBounds } from "../src/shell-window.js";
import { createBrowserSurface } from "../src/browser-surface.js";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createDesktopBrowserViews, type PageHost } from "../src/browser-views.js";

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

/** 셸이 만든 네이티브 뷰 — 이 계약이 보는 것은 만들어졌는지, 닫혔는지, 어떤 CDP 명령을 받았는지뿐이다. */
function fakeView(partition: string, created: Array<{ partition: string; closed: boolean; commands: string[] }>): WebContentsView {
  const record = { partition, closed: false, commands: [] as string[] };
  created.push(record);
  // 페이지 이동은 뷰가 닫힐 때까지 끝나지 않다가 닫히면 거부된다 — 재기동 순간에 걸려 있던 명령.
  let rejectPending: (error: Error) => void = () => {};
  const contents = Object.assign(new EventEmitter(), {
    session: { webRequest: { onBeforeSendHeaders: () => {} } },
    debugger: Object.assign(new EventEmitter(), {
      attach: () => {},
      detach: () => {},
      isAttached: () => true,
      sendCommand: (method: string) => {
        record.commands.push(method);
        return method === "Page.navigate" ? new Promise((_resolve, reject) => { rejectPending = reject; }) : Promise.resolve({});
      },
    }),
    setWindowOpenHandler: () => {},
    loadURL: async () => {},
    isFocused: () => false,
    close: () => { record.closed = true; rejectPending(new Error("target closed")); },
  });
  return { webContents: contents, setBorderRadius: () => {}, setBounds: vi.fn(), setVisible: () => {} } as unknown as WebContentsView;
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
      return { webContents, setBounds: vi.fn(), setBackgroundColor: vi.fn() };
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
      relay: vi.fn(), changed, log: vi.fn(),
    });
    surface.apply({ id: "surface-1", browserId: "global", mode: "pane" }, null, "http://127.0.0.1:1");
    const [bar, rail, , divider] = views as [ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>, ReturnType<typeof makeView>];
    const send = (doc: ReturnType<typeof makeView>, message: unknown[], frame = doc.webContents.mainFrame) => doc.webContents.emit("console-message", { frame, message: JSON.stringify(message) });
    // 첫 배치: 선호 폭 560 — Console | 손잡이 | (주소줄·레일·페이지) 가 한 번에 정해진다.
    expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 832, height: 900 });
    expect(divider.setBounds).toHaveBeenLastCalledWith({ x: 832, y: 0, width: 8, height: 900 });
    expect(bar.setBounds).toHaveBeenLastCalledWith({ x: 840, y: 0, width: 560, height: 52 });
    expect(rail.setBounds).toHaveBeenLastCalledWith({ x: 840, y: 52, width: 54, height: 848 });
    expect(surface.target()?.page).toEqual({ x: 894, y: 52, width: 506, height: 848 });
    const dividerSend = (action: string, x: number, frame = divider.webContents.mainFrame) => divider.webContents.emit("console-message", { frame, message: JSON.stringify(["fleet-pane", action, x]) });
    dividerSend("start", 850); dividerSend("move", 750);
    expect(surface.target()?.page).toEqual({ x: 794, y: 52, width: 606, height: 848 });
    expect(consoleView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 732, height: 900 });
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
    expect(surface.target()?.page).toEqual({ x: 845, y: 52, width: 255, height: 648 });
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
    const created: Array<{ partition: string; closed: boolean; commands: string[] }> = [];
    const mainHost = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 2, reclaimFocus: vi.fn() } satisfies PageHost;
    const childHost = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 1000, height: 760 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 2, reclaimFocus: vi.fn() } satisfies PageHost;
    let target: { host: PageHost; page: { x: number; y: number; width: number; height: number } } | null = null;
    const surface = { apply: vi.fn(), target: () => target, refresh: vi.fn(), dispose: vi.fn() };
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
