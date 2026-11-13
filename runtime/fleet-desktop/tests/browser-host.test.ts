import { EventEmitter } from "node:events";

import { DESKTOP_BROWSER_EVENT, DESKTOP_BROWSER_EVENTS_PATH, DESKTOP_BROWSER_OWNER_HEADER, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_RELAY_PATH, type DesktopBrowserRelay, type DesktopBrowserSnapshot } from "@fleet-console/protocol/desktop";
import type { WebContentsView } from "electron";
import { describe, expect, it, vi } from "vitest";

import { shellPublishHeaders, type ManagedBrowserConnection } from "../src/browser-connection.js";
import { createManagedBrowserHost, type ManagedBrowserDisplay } from "../src/browser-host.js";
import { createDesktopBrowserViews, type PageHost } from "../src/browser-views.js";

const HOME = "http://127.0.0.1:4310";
const WSL = "http://127.0.0.1:4311";
const REMOTE = "https://100.84.12.7:6768";

function snapshot(id: string): DesktopBrowserSnapshot {
  return {
    generation: 1,
    epoch: id,
    views: [{ id, objectiveId: "op-1", partition: `fleet-browser-${id}`, profile: null, visible: true, url: "about:blank" }],
    commands: [],
    surface: { id: `surface-${id}`, browserId: "global", mode: "pane" },
  };
}

describe("managed browser host across console switches", () => {
  it("parks home and WSL engines while a remote console is shown and does not lend them its token", async () => {
    const lifetimes = new Map<string, DesktopBrowserSnapshot>([[HOME, snapshot("home")], [WSL, snapshot("wsl")]]);
    const relays: { origin: string; body: DesktopBrowserRelay; headers: Headers }[] = [];
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      requests.push(url.origin + url.pathname);
      const headers = new Headers(init?.headers);
      if (url.pathname === DESKTOP_BROWSER_RELAY_PATH) {
        relays.push({ origin: url.origin, body: JSON.parse(String(init?.body)) as DesktopBrowserRelay, headers });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === DESKTOP_BROWSER_PATH) return Response.json(lifetimes.get(url.origin));
      if (url.pathname === DESKTOP_BROWSER_EVENTS_PATH) {
        const lifetime = lifetimes.get(url.origin);
        const frame = new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(frame); } }));
      }
      return new Response(null, { status: 404 });
    });
    const created: { id: string; closed: boolean }[] = [];
    const shell: PageHost = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 1, reclaimFocus: vi.fn() };
    const applied: unknown[] = [];
    let open = false;
    const display: ManagedBrowserDisplay = {
      apply(surface) { open = surface !== null; applied.push(surface?.id ?? null); },
      conceal() { open = false; applied.push("conceal"); },
      target: () => (open ? { host: shell, page: { x: 12, y: 12, width: 640, height: 480 } } : null),
      lastPage: () => null,
      inputLocked: () => false,
      refresh() {},
      dispose: vi.fn(),
    };
    const fakeView = (): WebContentsView => {
      const record = { id: "", closed: false };
      created.push(record);
      const contents = Object.assign(new EventEmitter(), {
        session: { webRequest: { onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} } },
        debugger: Object.assign(new EventEmitter(), { attach: () => {}, detach: () => {}, isAttached: () => true, sendCommand: () => Promise.resolve({}) }),
        setWindowOpenHandler: () => {}, loadURL: async () => {}, isFocused: () => false, isDestroyed: () => record.closed,
        close: () => { record.closed = true; },
      });
      return { webContents: contents, setBorderRadius: () => {}, setBounds: vi.fn(), setVisible: () => {} } as unknown as WebContentsView;
    };
    const connections: ManagedBrowserConnection[] = [
      { key: "home", origin: HOME, token: "home-token", ownerId: "owner-1", accessPath: "loopback" },
      { key: "wsl:one", origin: WSL, token: "wsl-token", ownerId: "owner-1", accessPath: "wsl" },
    ];
    const host = createManagedBrowserHost({
      display,
      createSession: (connection, surface) => createDesktopBrowserViews({
        shell: () => shell,
        consoleContents: () => null,
        surface,
        createView: () => { const view = fakeView(); created.at(-1)!.id = connection.key; return view; },
        product: () => "Chrome/150.0",
        userAgent: () => "Mozilla/5.0",
        auth: () => ({ token: connection.token, ownerId: connection.ownerId }),
        hostLabel: () => "desk",
        platform: "win32",
        accessPath: connection.accessPath,
        fetch: fetch as typeof globalThis.fetch,
      }),
    });

    await host.sync(connections, HOME);
    await vi.waitFor(() => expect(created.map((entry) => entry.id).sort()).toEqual(["home", "wsl:one"]));
    expect(created.every((entry) => !entry.closed)).toBe(true);
    expect(applied.at(-1)).toBe("surface-home");
    expect(requests.some((url) => url.startsWith(REMOTE))).toBe(false);
    const hello = (origin: string) => relays.find((relay) => relay.origin === origin && relay.body.hello);
    expect(hello(HOME)?.body.hello).toMatchObject({ accessPath: "loopback", hostLabel: "desk", platform: "win32" });
    expect(hello(WSL)?.body.hello).toMatchObject({ accessPath: "wsl" });
    expect(hello(HOME)?.headers.get("authorization")).toBe("Bearer home-token");
    expect(hello(WSL)?.headers.get("authorization")).toBe("Bearer wsl-token");
    expect(hello(HOME)?.headers.get(DESKTOP_BROWSER_OWNER_HEADER)).toBe("owner-1");
    expect(host.shownOrigin()).toBe(HOME);

    await host.sync(connections, REMOTE);
    expect(created.every((entry) => !entry.closed)).toBe(true);
    expect(applied.at(-1)).toBe("conceal");
    expect(host.shownOrigin()).toBeNull();
    expect(requests.some((url) => url.startsWith(REMOTE))).toBe(false);
    expect(relays.some((relay) => relay.body.surface?.status === "closed")).toBe(false);

    lifetimes.set(HOME, { ...snapshot("home"), generation: 2, chrome: null });
    await host.sync(connections, HOME);
    expect(created.every((entry) => !entry.closed)).toBe(true);
    expect(applied.at(-1)).toBe("surface-home");
    expect(host.shownConnection()?.token).toBe("home-token");
    expect(shellPublishHeaders(REMOTE, host.shownConnection())).not.toHaveProperty("Authorization");
    expect(shellPublishHeaders(HOME, connections[0]!).Authorization).toBe("Bearer home-token");
    expect(shellPublishHeaders(WSL, connections[0]!)).not.toHaveProperty("Authorization");

    host.stopAll();
    expect(created.every((entry) => entry.closed)).toBe(true);
  });

  it("drops a session that finishes starting after the host was stopped", async () => {
    let started = false;
    let release: () => void = () => {};
    const stopped: string[] = [];
    const host = createManagedBrowserHost({
      display: { apply() {}, conceal() {}, target: () => null, lastPage: () => null, inputLocked: () => false, refresh() {}, dispose() {} },
      createSession: (connection) => ({
        start: () => { started = true; return new Promise<void>((resolve) => { release = () => resolve(); }); },
        stop: () => { stopped.push(connection.key); },
        refresh() {},
        places() {},
        relaySurface() {},
        attachShortcutSource() {},
      }),
    });
    const connection: ManagedBrowserConnection = { key: "home", origin: HOME, token: "home-token", ownerId: "owner-1", accessPath: "loopback" };
    const pending = host.sync([connection], HOME);
    await vi.waitFor(() => expect(started).toBe(true));
    host.stopAll();
    release();
    await pending;
    expect(stopped).toEqual(["home"]);
    expect(host.shownOrigin()).toBeNull();
  });
});
