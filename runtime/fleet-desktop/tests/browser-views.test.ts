import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readChromeHistory } from "../src/chrome-history.js";
import { createBrowserHistoryStorage } from "../src/browser-history-storage.js";
import { DESKTOP_BROWSER_EVENT, DESKTOP_BROWSER_EVENTS_PATH, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_RELAY_PATH, type DesktopBrowserRelay, type DesktopBrowserSnapshot } from "@fleet-console/protocol/desktop";
import type { WebContentsView } from "electron";

import { describe, expect, it, vi } from "vitest";

import { createDesktopBrowserViews } from "../src/browser-views.js";
import type { DesktopShellWindow } from "../src/shell-window.js";

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
  return { id, objectiveId: "op-1", partition: "fleet-browser-1", profile: null, visible: false, bounds: null, url: "about:blank" };
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
  return { webContents: contents, setBorderRadius: () => {}, setBounds: () => {}, setVisible: () => {} } as unknown as WebContentsView;
}

/**
 * 원격 Console 이 셀프 업데이트로 재기동하면 셸에는 같은 origin 의 스트림이 끊겼다 다시 붙는 것으로만 보인다. 새 프로세스는
 * generation 과 명령 id 를 처음부터 다시 세므로, 셸이 옛 수명의 표를 들고 있으면 새 탭의 뷰를 만들지 못하고 Console 은
 * 부착을 기다리다 시간 초과로 실패한다(Desktop 을 다시 켜야만 풀리던 증상).
 */
describe("desktop native browser views across a Console restart", () => {
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
    const shell = {
      isDestroyed: () => false,
      stack: { layoutConsole: () => ({ x: 0, y: 0, width: 1200, height: 800 }), parkBrowser: () => {}, presentBrowser: () => {}, removeBrowser: () => {} },
    } as unknown as DesktopShellWindow;
    const views = createDesktopBrowserViews({
      shell: () => shell,
      createView: (partition) => fakeView(partition, created),
      zoomFactor: () => 1,
      scaleFactor: () => 2,
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
    views.stop();
  });
});
