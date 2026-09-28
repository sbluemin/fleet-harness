import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createProxyBroker } from "../src/proxy-broker-client.js";
import { createProxyDataViews } from "../src/proxy-data-view.js";
import { createProxyPresentation } from "../src/proxy-presentation.js";

const LOCAL = "http://127.0.0.1:4310";
const REMOTE = "https://100.84.12.7:6768";
const EPOCH_ORIGIN = "http://127.0.0.1:51234";
const EPOCH = { epochId: "epoch_0001abcd", generation: 1, origin: EPOCH_ORIGIN, cookieName: "fleet_epoch_epoch_0001abcd", capability: "c".repeat(43) };
const SESSION_VALUE = "s".repeat(43);
const attempt = { generation: 7, isCurrent: () => true };

function partitionSession(options: { readonly resolve?: (url: string) => string; readonly leftovers?: boolean } = {}) {
  const cookies: Array<{ name: string; value: string; httpOnly: boolean; secure?: boolean }> = [];
  const events = new EventEmitter();
  let onBeforeRequest: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | null = null;
  const session = {
    webRequest: { onBeforeRequest: vi.fn((_filter: unknown, listener: typeof onBeforeRequest) => { onBeforeRequest = listener; }) },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setSpellCheckerEnabled: vi.fn(),
    on: (name: string, listener: (...args: unknown[]) => void) => events.on(name, listener),
    setProxy: vi.fn(async () => undefined),
    resolveProxy: vi.fn(async (url: string) => options.resolve?.(url) ?? (url.startsWith(EPOCH_ORIGIN) ? "DIRECT" : "PROXY 127.0.0.1:51234")),
    cookies: {
      set: vi.fn(async (details: { name: string; value: string; httpOnly: boolean; secure?: boolean }) => { cookies.push({ name: details.name, value: details.value, httpOnly: details.httpOnly, secure: details.secure }); }),
      get: vi.fn(async () => cookies.map((cookie) => ({ ...cookie }))),
    },
    clearStorageData: vi.fn(async () => { if (!options.leftovers) cookies.length = 0; }),
    clearCache: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
  };
  const request = (url: string): boolean => {
    let cancelled = false;
    onBeforeRequest?.({ url }, (response) => { cancelled = response.cancel; });
    return cancelled;
  };
  return { session, cookies, request };
}

function fakeView() {
  const contents = Object.assign(new EventEmitter(), {
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(function (this: EventEmitter) { queueMicrotask(() => this.emit("destroyed")); }),
  });
  return { view: { webContents: contents }, contents };
}

describe("read-only proxy epoch", () => {
  /**
   * 위임되는 자격은 조인한 그 포트의 세션 쿠키 하나뿐이고, monitoring이면서 같은 버전인 콘솔에만 간다. 그 밖에는
   * 같은 세션으로 직결하며 다시 조인하지 않는다.
   */
  it("delegates only the selected port's session, and only for a same-version monitoring console", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const broker = createProxyBroker({
      localOrigin: () => LOCAL,
      lockToken: () => "lock-token",
      randomId: () => "2b7e1a4c-8f3d-4a6b-9c1e-5d2f7a8b9c0d",
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith("/api/v1/proxy/owners")) return Response.json({ ownerLeaseId: "owner_0001abcd", heartbeatMs: 10_000 }, { status: 201 });
        if (url.includes("/api/v1/proxy/events")) return new Response(new ReadableStream({ start() { /* 열린 채로 둔다 */ } }), { status: 200 });
        return Response.json({ error: "access_not_monitoring" }, { status: 409 });
      }) as never,
      onTerminal: () => undefined,
      onOwnerLost: () => undefined,
    });
    const readSessionCookie = vi.fn(async () => SESSION_VALUE);
    const probe = { access: "monitoring", version: "1.200.0" };
    const presentation = createProxyPresentation({
      enabled: () => true,
      broker,
      views: { open: vi.fn(), unusable: () => false },
      shell: () => null,
      readSessionCookie,
      probeRemote: async () => probe,
      localVersion: async () => "1.200.0",
      cover: async (_url, _views, load) => load(),
    });
    const target = { origin: REMOTE, hostId: "host-1", pinGeneration: 2, port: 6768, sessionCookieName: "fleet_console_session_6768", carry: "" };

    await expect(presentation.tryPresent(target, attempt)).resolves.toBe(false);
    expect(readSessionCookie).toHaveBeenCalledWith(REMOTE, "fleet_console_session_6768");
    const delegation = requests.find((request) => request.url.endsWith("/api/v1/proxy/epochs"))?.body as Record<string, unknown>;
    expect(delegation).toEqual({
      requestId: "2b7e1a4c-8f3d-4a6b-9c1e-5d2f7a8b9c0d",
      ownerLeaseId: "owner_0001abcd",
      switchGeneration: 7,
      hostId: "host-1",
      pinGeneration: 2,
      session: { name: "fleet_console_session_6768", value: SESSION_VALUE },
    });

    // full 좌석이거나 버전이 다르면 broker에 묻지도 않는다 — 자격은 위임되지 않는다.
    requests.length = 0;
    readSessionCookie.mockClear();
    probe.access = "full";
    await expect(presentation.tryPresent(target, attempt)).resolves.toBe(false);
    probe.access = "monitoring";
    probe.version = "1.199.0";
    await expect(presentation.tryPresent(target, attempt)).resolves.toBe(false);
    expect(readSessionCookie).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  /** 격리를 세우지 못하면 그 뷰를 쓰지 않는다. 확인은 적재 전이고, 세운 것은 모두 비운다. */
  it("refuses an isolated view whose proxy does not fence the network, before anything loads", async () => {
    const fenced = partitionSession({ resolve: () => "DIRECT" });
    const createView = vi.fn();
    const views = createProxyDataViews({ sessionFor: () => fenced.session as never, createView, attach: () => undefined });

    await expect(views.open(EPOCH)).rejects.toThrow("proxy_isolation_unverified");
    expect(createView).not.toHaveBeenCalled();
    expect(fenced.cookies).toEqual([]);
    expect(fenced.session.clearStorageData).toHaveBeenCalled();
    // 같은 epoch의 partition은 다시 쓰지 않는다.
    await expect(views.open(EPOCH)).rejects.toThrow("proxy_partition_reused");
  });

  /**
   * epoch origin 밖으로는 아무것도 나가지 않고, 끝낼 때는 요청을 먼저 막은 뒤 렌더러를 닫고 저장소를 비우고 확인한다.
   * 비었는지 확인하지 못하면 실패로 끝내고, 그 실행에서는 더 이상 격리 뷰를 열지 않는다.
   */
  it("keeps the view inside its epoch and fails closed when cleanup cannot be confirmed", async () => {
    const partition = partitionSession({ leftovers: true });
    const { view, contents } = fakeView();
    const views = createProxyDataViews({ sessionFor: () => partition.session as never, createView: () => view as never, attach: () => undefined });

    const surface = await views.open(EPOCH);
    expect(partition.session.setProxy).toHaveBeenCalledWith({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:51234", proxyBypassRules: "127.0.0.1:51234;<-loopback>" });
    expect(partition.cookies).toEqual([expect.objectContaining({ name: EPOCH.cookieName, httpOnly: true })]);
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
    expect(partition.request(`${EPOCH_ORIGIN}/api/v1/operations`)).toBe(false);
    expect(partition.request(`${LOCAL}/api/v1/operations`)).toBe(true);
    expect(partition.request("https://evil.example/")).toBe(true);

    await expect(surface.teardown()).rejects.toThrow("proxy_cleanup_unconfirmed");
    expect(contents.close).toHaveBeenCalled();
    expect(partition.request(`${EPOCH_ORIGIN}/api/v1/operations`)).toBe(true);
    expect(views.unusable()).toBe(true);
    await expect(views.open({ ...EPOCH, epochId: "epoch_0002abcd", cookieName: "fleet_epoch_epoch_0002abcd" })).rejects.toThrow("proxy_view_unavailable");
  });
});
