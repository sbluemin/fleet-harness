import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_PREVIEW_MAX_SESSIONS,
  RemotePreviewHub,
  createRemotePreviewRouter,
  receivesRemotePreviewState,
  receivesRemotePreviewViewers,
  toRemotePreviewTarget,
  type RemotePreviewSubscriber,
  type RemotePreviewRouteDeps,
} from "../features/computer-use/host/remote-preview.js";
import {
  DESKTOP_OFFSCREEN_PREVIEW_STILL_PATH,
  DESKTOP_REMOTE_PREVIEW_FRAME_PATH,
  REMOTE_PREVIEW_AGE_HEADER,
  REMOTE_PREVIEW_FRAME_PATH,
  REMOTE_PREVIEW_MAX_BYTES,
  REMOTE_PREVIEW_SEQ_HEADER,
  REMOTE_PREVIEW_STATE_PATH,
  readRemotePreviewState,
} from "../features/computer-use/shared/remote-preview.js";

/**
 * 원격 미리보기(결정 8cd1a62d)의 노출 범위: 원격 full에게만, 메모리 최신 1장만, 대상이 바뀌거나 끝나거나 호스트가 끄면 즉시 폐기.
 */

const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, marker, 0xff, 0xd9]);
const target = (id = "target-1") => ({ id, ownerKind: "commodore" as const, objectiveId: null, commodoreId: "commodore-1", actor: "commodore-1" });

const hubs: RemotePreviewHub[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.dispose();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.useRealTimers();
});

function hubWith(options: { graceMs?: number; waitMs?: number; maxSessions?: number; now?: () => number } = {}) {
  const viewerEvents: number[] = [];
  const hub = new RemotePreviewHub({ onViewersChanged: (count) => viewerEvents.push(count), ...options });
  hubs.push(hub);
  return { hub, viewerEvents };
}

describe("RemotePreviewHub", () => {
  it("takes a still only for the current target while sending is on and a full session is watching", async () => {
    const { hub, viewerEvents } = hubWith({ waitMs: 50 });
    expect(hub.accept("target-1", jpeg(1))).toBe("no_target");
    hub.update(target(), true);
    expect(hub.accept("target-1", jpeg(1))).toBe("no_viewers");
    const watching = hub.watch("session-a", 0);
    expect(viewerEvents).toEqual([1]);
    expect(hub.accept("other-target", jpeg(1))).toBe("stale_target");
    expect(hub.accept("target-1", jpeg(2))).toBe("ok");
    const result = await watching;
    expect(result).toMatchObject({ kind: "frame", frame: { seq: 1, targetId: "target-1" } });
    // 메모리에 최신 1장만 든다.
    expect(hub.accept("target-1", jpeg(3))).toBe("ok");
    expect(hub.frame()?.seq).toBe(2);
    expect(hub.frame()?.jpeg.equals(jpeg(3))).toBe(true);
  });

  it("drops the still and ends waiting watchers the moment the target changes, use ends, or the host turns sending off", async () => {
    for (const end of [
      (hub: RemotePreviewHub) => hub.update(target("target-2"), true),
      (hub: RemotePreviewHub) => hub.update(null, true),
      (hub: RemotePreviewHub) => hub.update(target(), false),
    ]) {
      const { hub, viewerEvents } = hubWith({ waitMs: 5000 });
      hub.update(target(), true);
      const first = hub.watch("session-a", 0);
      hub.accept("target-1", jpeg(1));
      await first;
      const waiting = hub.watch("session-a", 1);
      expect(hub.frame()).not.toBeNull();
      expect(end(hub)).toBe(true);
      expect(await waiting).toEqual({ kind: "ended" });
      expect(hub.frame()).toBeNull();
      // 시청 흔적도 지워 호스트가 곧바로 뽑기를 멈춘다.
      expect(viewerEvents.at(-1)).toBe(0);
      expect(hub.viewers()).toBe(0);
    }
  });

  it("answers unavailable while there is nothing to show and reports the host-off state without a target leak", () => {
    const { hub } = hubWith();
    expect(hub.state()).toEqual({ target: null, sending: false });
    hub.update(target(), false);
    expect(hub.state()).toEqual({ target: target(), sending: false });
    return expect(hub.watch("session-a", 0)).resolves.toEqual({ kind: "unavailable" });
  });

  it("keeps one waiting request per session, a cap on distinct sessions, and forgets a session at once when it ends", async () => {
    const { hub, viewerEvents } = hubWith({ waitMs: 5000 });
    hub.update(target(), true);
    const first = hub.watch("session-a", 0);
    const second = hub.watch("session-a", 0);
    expect(await first).toEqual({ kind: "superseded" });
    expect(hub.viewers()).toBe(1);
    const others = Array.from({ length: REMOTE_PREVIEW_MAX_SESSIONS - 1 }, (_, index) => hub.watch(`session-${index}`, 0));
    expect(hub.viewers()).toBe(REMOTE_PREVIEW_MAX_SESSIONS);
    expect(await hub.watch("session-extra", 0)).toEqual({ kind: "busy" });
    hub.forgetSession("session-a");
    expect(await second).toEqual({ kind: "ended" });
    expect(hub.viewers()).toBe(REMOTE_PREVIEW_MAX_SESSIONS - 1);
    hub.update(null, true);
    await Promise.all(others);
    expect(viewerEvents.at(-1)).toBe(0);
  });

  it("counts a watcher between polls for the grace period, then stops counting and drops the still", async () => {
    let now = 1_000;
    const { hub, viewerEvents } = hubWith({ waitMs: 5000, graceMs: 100, now: () => now });
    hub.update(target(), true);
    const controller = new AbortController();
    const waiting = hub.watch("session-a", 0, controller.signal);
    hub.accept("target-1", jpeg(1));
    await waiting;
    // 응답을 받고 다음 요청 전 — 아직 보는 중이다.
    expect(hub.viewers()).toBe(1);
    now += 150;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(hub.viewers()).toBe(0);
    expect(viewerEvents).toEqual([1, 0]);
    expect(hub.frame()).toBeNull();
  });

  it("withdraws a waiting request whose connection closes", async () => {
    const { hub } = hubWith({ waitMs: 5000, graceMs: 20 });
    hub.update(target(), true);
    const controller = new AbortController();
    const waiting = hub.watch("session-a", 0, controller.signal);
    controller.abort();
    expect(await waiting).toEqual({ kind: "ended" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hub.viewers()).toBe(0);
  });

  it("strips native window identity before anything reaches a remote screen", () => {
    const projected = toRemotePreviewTarget({ ...target(), pid: 5, windowId: 10, processStartedAt: 100, title: "Secret.txt" } as Parameters<typeof toRemotePreviewTarget>[0]);
    expect(projected).toEqual(target());
    expect(readRemotePreviewState({ target: { ...target(), title: "Secret.txt", windowId: 10 }, sending: true })).toEqual({ target: target(), sending: true });
  });
});

describe("remote preview SSE recipients", () => {
  const subscriber = (overrides: Partial<RemotePreviewSubscriber>): RemotePreviewSubscriber => ({ audience: "remote", client: "browser", access: "full", ...overrides });
  it("sends preview state only to full remote screens and viewer counts only to the local Desktop", () => {
    expect(receivesRemotePreviewState(subscriber({}))).toBe(true);
    expect(receivesRemotePreviewState(subscriber({ client: "desktop" }))).toBe(true);
    expect(receivesRemotePreviewState(subscriber({ access: "monitoring" }))).toBe(false);
    expect(receivesRemotePreviewState(subscriber({ client: "objective-browser" }))).toBe(false);
    expect(receivesRemotePreviewState(subscriber({ audience: "local", access: null }))).toBe(false);
    expect(receivesRemotePreviewViewers(subscriber({ audience: "local", client: "desktop", access: null }))).toBe(true);
    expect(receivesRemotePreviewViewers(subscriber({ audience: "local", client: "browser", access: null }))).toBe(false);
    expect(receivesRemotePreviewViewers(subscriber({ client: "desktop" }))).toBe(false);
    expect(receivesRemotePreviewViewers(subscriber({ client: "desktop", access: "monitoring" }))).toBe(false);
  });
});

/**
 * 실제 HTTP 위의 라우터. 리스너·세션·출처는 헤더로 흉내 낸다 — 서버의 실제 판정 함수는 같은 자리에 꽂힌다.
 * x-test-listener: local|remote, x-test-session: <handle>:<full|monitoring>, x-test-origin: exact|none, x-test-read: same|cross, user-agent: Electron/…
 */
async function serve(hub: RemotePreviewHub, still?: Pick<RemotePreviewRouteDeps, "captureTarget" | "captureStill">) {
  const router = createRemotePreviewRouter({
    hub,
    isLoopbackListener: (req) => req.headers["x-test-listener"] !== "remote",
    isExactConsoleOrigin: (req) => req.headers["x-test-origin"] === "exact",
    isSameOriginConsoleRead: (req) => req.headers["x-test-read"] !== "cross",
    isDesktopClient: (req) => /\bElectron\//u.test(String(req.headers["user-agent"] ?? "")),
    remoteSession: (req) => {
      if (req.headers["x-test-listener"] !== "remote") return null;
      const raw = req.headers["x-test-session"];
      if (typeof raw !== "string") return null;
      const [handle, access] = raw.split(":");
      return { handle: handle!, access: access === "monitoring" ? "monitoring" : "full" };
    },
    writeJson: (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); },
    withSecurityHeaders: (headers) => headers,
    refresh: () => { refreshed += 1; },
    ...(still ?? { captureTarget: () => null, captureStill: async () => null }),
  });
  let refreshed = 0;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void router({ req, res, pathname }).then((handled) => { if (!handled) { res.writeHead(418); res.end(); } });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = { "x-test-origin": "exact", "user-agent": "Mozilla/5.0 Electron/43.1.0", "content-type": "image/jpeg" };
  const upload = (body: Buffer, targetId = "target-1", headers: Record<string, string> = host) =>
    fetch(`${base}${DESKTOP_REMOTE_PREVIEW_FRAME_PATH}?target=${targetId}`, { method: "POST", headers, body: new Uint8Array(body) });
  const watch = (session: string | null, afterSeq = 0, extra: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(`${base}${REMOTE_PREVIEW_FRAME_PATH}?afterSeq=${afterSeq}`, { headers: { "x-test-listener": "remote", ...(session ? { "x-test-session": session } : {}), ...extra }, ...(signal ? { signal } : {}) });
  const readState = (session: string | null, extra: Record<string, string> = {}) =>
    fetch(`${base}${REMOTE_PREVIEW_STATE_PATH}`, { headers: { "x-test-listener": "remote", ...(session ? { "x-test-session": session } : {}), ...extra } });
  return { base, upload, watch, readState, host, refreshes: () => refreshed };
}

describe("remote preview routes", () => {
  it("lets only the local Desktop window upload a still, only as JPEG, only within the size cap", async () => {
    const { hub } = hubWith({ waitMs: 2000 });
    const { upload, host, base } = await serve(hub);
    hub.update(target(), true);
    expect((await fetch(`${base}${DESKTOP_REMOTE_PREVIEW_FRAME_PATH}?target=target-1`, { method: "POST", headers: { ...host, "x-test-listener": "remote" }, body: new Uint8Array(jpeg(1)) })).status).toBe(404);
    expect((await upload(jpeg(1), "target-1", { ...host, "x-test-origin": "none" })).status).toBe(403);
    expect((await upload(jpeg(1), "target-1", { ...host, "user-agent": "Mozilla/5.0 Chrome/140" })).status).toBe(403);
    expect((await upload(Buffer.from("not a jpeg"))).status).toBe(400);
    expect((await upload(Buffer.concat([jpeg(1), Buffer.alloc(REMOTE_PREVIEW_MAX_BYTES)]))).status).toBe(400);
    // 아무도 보지 않으면 받지 않는다.
    expect(await (await upload(jpeg(1))).json()).toEqual({ error: "no_viewers" });
    expect(hub.frame()).toBeNull();
  });

  it("only captures the current offscreen target for the exact-origin loopback Desktop, with no frame on permission denial or release", async () => {
    const { hub } = hubWith();
    const window = { ...target(), pid: 5, windowId: 10, processStartedAt: 100, title: "Fixture", offscreen: true };
    let live: typeof window | null = window;
    let reply: () => Promise<Buffer | null> = async () => jpeg(7);
    const captureStill = vi.fn(() => reply());
    const { base, host } = await serve(hub, { captureTarget: () => live, captureStill });
    const read = (params = "target=target-1", headers: Record<string, string> = host) => fetch(`${base}${DESKTOP_OFFSCREEN_PREVIEW_STILL_PATH}?${params}`, { method: "POST", headers });
    for (const tier of ["full", "monitoring"]) {
      expect((await read(undefined, { ...host, "x-test-listener": "remote", "x-test-session": `viewer:${tier}` })).status).toBe(404);
    }
    expect((await read(undefined, { ...host, "x-test-origin": "none" })).status).toBe(403);
    expect((await read(undefined, { ...host, "user-agent": "Chrome/140" })).status).toBe(403);
    expect((await read("target=target-1&pid=5")).status).toBe(400);
    expect((await read("target=unexpected")).status).toBe(204);
    live = { ...window, offscreen: false };
    expect((await read()).status).toBe(204);
    expect(captureStill).not.toHaveBeenCalled();

    live = window;
    const shown = await read();
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toBe("image/jpeg");
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await shown.arrayBuffer())).toEqual(jpeg(7));
    expect(captureStill).toHaveBeenCalledWith(window, expect.any(AbortSignal));
    expect(hub.frame()).toBeNull();

    // 권한 없음은 헬퍼 포트에서 null로 돌아온다. HTTP는 조용히 장을 내지 않는다.
    reply = async () => null;
    expect((await read()).status).toBe(204);
    for (const next of [{ ...window, id: "target-2" }, null]) {
      let release!: (bytes: Buffer) => void;
      live = window;
      captureStill.mockClear();
      reply = () => new Promise<Buffer>((resolve) => { release = resolve; });
      const pending = read();
      await vi.waitFor(() => expect(captureStill).toHaveBeenCalledTimes(1));
      expect((await read()).status).toBe(204);
      expect(captureStill).toHaveBeenCalledTimes(1);
      live = next;
      release(jpeg(8));
      const response = await pending;
      expect(response.status).toBe(204);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it("serves the latest still to a full remote session and refuses loopback, unauthenticated, monitoring, and cross-origin reads", async () => {
    const { hub } = hubWith({ waitMs: 2000 });
    const { base, upload, watch } = await serve(hub);
    hub.update(target(), true);
    expect((await fetch(`${base}${REMOTE_PREVIEW_FRAME_PATH}`)).status).toBe(404);
    expect((await watch(null)).status).toBe(401);
    const monitoring = await watch("watcher:monitoring");
    expect(monitoring.status).toBe(403);
    expect(await monitoring.json()).toEqual({ error: "preview_full_only" });
    expect((await watch("session-a:full", 0, { "x-test-read": "cross" })).status).toBe(403);
    // 거부된 요청은 시청자로 세지 않는다.
    expect(hub.viewers()).toBe(0);

    const pending = watch("session-a:full");
    await vi.waitFor(() => expect(hub.viewers()).toBe(1));
    expect((await upload(jpeg(7))).status).toBe(204);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(REMOTE_PREVIEW_SEQ_HEADER)).toBe("1");
    expect(Number(response.headers.get(REMOTE_PREVIEW_AGE_HEADER))).toBeGreaterThanOrEqual(0);
    expect(Buffer.from(await response.arrayBuffer()).equals(jpeg(7))).toBe(true);
  });

  it("ends a waiting remote read with no content when use ends, and answers 409 once nothing is shown or the host turned sending off", async () => {
    const { hub } = hubWith({ waitMs: 2000 });
    const { watch } = await serve(hub);
    expect((await watch("session-a:full")).status).toBe(409);
    hub.update(target(), true);
    const pending = watch("session-a:full");
    await vi.waitFor(() => expect(hub.viewers()).toBe(1));
    hub.update(null, true);
    expect((await pending).status).toBe(204);
    hub.update(target(), false);
    const off = await watch("session-a:full");
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "preview_unavailable" });
  });

  it("lets a full remote screen that subscribed late read the current state once, under the same gate as frames", async () => {
    const { hub } = hubWith({ waitMs: 2000 });
    const { base, readState, refreshes } = await serve(hub);
    hub.update(target(), true);
    expect((await fetch(`${base}${REMOTE_PREVIEW_STATE_PATH}`)).status).toBe(404);
    expect((await readState(null)).status).toBe(401);
    expect((await readState("watcher:monitoring")).status).toBe(403);
    expect((await readState("session-a:full", { "x-test-read": "cross" })).status).toBe(403);
    const before = refreshes();
    const response = await readState("session-a:full");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ target: target(), sending: true });
    // 읽기 전에 캡처 대상·설정에 맞춘다.
    expect(refreshes()).toBe(before + 1);
    // 상태 읽기는 시청이 아니다 — 호스트가 장을 뽑기 시작하지 않는다.
    expect(hub.viewers()).toBe(0);
    hub.update(target(), false);
    expect(await (await readState("session-a:full")).json()).toEqual({ target: target(), sending: false });
  });

  it("refuses a fifth distinct session while four are watching", async () => {
    const { hub } = hubWith({ waitMs: 2000 });
    const { watch } = await serve(hub);
    hub.update(target(), true);
    const controller = new AbortController();
    const pending = Array.from({ length: REMOTE_PREVIEW_MAX_SESSIONS }, (_, index) => watch(`session-${index}:full`, 0, {}, controller.signal).catch(() => null));
    await vi.waitFor(() => expect(hub.viewers()).toBe(REMOTE_PREVIEW_MAX_SESSIONS));
    const extra = await watch("session-extra:full");
    expect(extra.status).toBe(429);
    controller.abort();
    await Promise.all(pending);
  });
});
