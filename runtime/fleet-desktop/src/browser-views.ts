import type { BrowserWindow, WebContentsView } from "electron";
import {
  DESKTOP_BROWSER_EVENT,
  DESKTOP_BROWSER_EVENTS_PATH,
  DESKTOP_BROWSER_PATH,
  DESKTOP_BROWSER_RELAY_PATH,
  isDesktopBrowserSnapshot,
  type DesktopBrowserRelay,
  type DesktopBrowserSnapshot,
  type DesktopBrowserView,
} from "@fleet-console/desktop-protocol";

import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream, type DesktopEventStream } from "./desktop-event-stream.js";

/**
 * Operation 브라우저를 창 안의 실제 Chromium 뷰로 그린다.
 *
 * 콘솔은 탭·정책·도구를 소유하고, 이 셸은 "어디에 어떤 뷰를 놓을지"와 "그 뷰의 디버거로 이 명령을 보내라"를
 * 스냅샷으로 받아 수행할 뿐이다. 사람은 뷰를 직접 보고 만진다 — 픽셀을 찍어 보내는 일이 없다. 에이전트의
 * 눈과 손은 콘솔이 보낸 CDP 명령이고, 그 응답과 페이지 이벤트는 relay 로 되돌아간다. 방향은 테마·업데이트
 * 동기화와 같다: 셸이 구독하고, 셸이 되돌려 보낸다. 렌더러는 이 배관을 모른다.
 */

export const MAX_DESKTOP_BROWSER_SSE_BUFFER_CHARS = 16 * 1024 * 1024;
const RELAY_FLUSH_MS = 8;
/** relay 가 닿지 않으면 같은 배치를 이만큼 뒤에 다시 보낸다 — 순서는 지킨다. */
const RELAY_RETRY_MS = 500;
/** Chromium 이 순서를 지켜 주는 이벤트지만, 한 번에 너무 많이 쌓이면 relay 하나가 콘솔의 한도를 넘는다. */
const RELAY_MAX_EVENTS = 400;

export interface DesktopBrowserViewsDeps {
  readonly window: () => BrowserWindow | null;
  readonly createView: (partition: string) => WebContentsView;
  /** 콘솔 창 렌더러의 줌 배율 — 패널이 알린 CSS px 를 DIP 로 바꾼다. */
  readonly zoomFactor: () => number;
  /** 뷰가 놓인 화면의 배율 — 콘솔이 스크린샷 픽셀을 CSS px 로 되돌릴 때 쓴다. */
  readonly scaleFactor: () => number;
  readonly product: () => string;
  readonly userAgent: () => string;
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
}

export interface DesktopBrowserViews {
  start(origin: string): Promise<void>;
  stop(): void;
  /** 창 크기·줌이 바뀌었다 — 놓인 자리를 다시 계산한다. */
  refresh(): void;
}

interface LiveView {
  readonly view: WebContentsView;
  readonly spec: DesktopBrowserView;
  attached: boolean;
  lastBounds: { x: number; y: number; width: number; height: number } | null;
}

export function createDesktopBrowserViews(deps: DesktopBrowserViewsDeps): DesktopBrowserViews {
  const fetchFor = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? (() => {});
  const live = new Map<string, LiveView>();
  const executed = new Set<number>();
  let origin: string | null = null;
  let generation = -1;
  let outbox: DesktopBrowserRelay & { attached: string[]; detached: string[]; sizes: { viewId: string; width: number; height: number; scale: number }[]; results: { id: number; result?: unknown; error?: string }[]; events: { viewId: string; method: string; params: Record<string, unknown> }[] } = emptyOutbox();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> = Promise.resolve();

  function emptyOutbox() { return { attached: [] as string[], detached: [] as string[], sizes: [] as { viewId: string; width: number; height: number; scale: number }[], results: [] as { id: number; result?: unknown; error?: string }[], events: [] as { viewId: string; method: string; params: Record<string, unknown> }[] }; }

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, RELAY_FLUSH_MS);
  };

  const flush = (): void => {
    const target = origin;
    if (!target) { outbox = emptyOutbox(); return; }
    if (outbox.attached.length + outbox.detached.length + outbox.sizes.length + outbox.results.length + outbox.events.length === 0) return;
    const batch = outbox;
    outbox = emptyOutbox();
    const body: DesktopBrowserRelay = {
      ...(batch.attached.length ? { attached: batch.attached } : {}),
      ...(batch.detached.length ? { detached: batch.detached } : {}),
      ...(batch.sizes.length ? { sizes: batch.sizes } : {}),
      ...(batch.results.length ? { results: batch.results } : {}),
      ...(batch.events.length ? { events: batch.events } : {}),
    };
    // 순서가 곧 의미다(이벤트·응답) — 한 번에 하나씩, 앞 것이 닿은 뒤에 보낸다. 닿지 않으면 같은 자리에서 잠시 뒤 다시
    // 보낸다: 뒤에 줄 선 배치는 이 배치가 닿을 때까지 기다린다. 부착 통지나 명령 응답 하나가 사라지거나 순서가 뒤집히면
    // 콘솔은 시간 초과까지 기다리거나 페이지 상태를 거꾸로 읽는다.
    flushing = flushing.then(async () => {
      while (origin === target) {
        if (await send(target, body)) return;
        await new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_MS));
      }
    }).catch(() => undefined);
  };

  const send = async (target: string, body: DesktopBrowserRelay): Promise<boolean> => {
    try {
      const response = await fetchFor(`${target}${DESKTOP_BROWSER_RELAY_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: target }, body: JSON.stringify(body) });
      if (response.ok) return true;
      log(`browser relay rejected status=${response.status}`);
      // 콘솔이 몸을 거절한 것(400)은 다시 보내도 같다 — 버린다. 나머지는 잠시 뒤 다시.
      return response.status === 400;
    } catch (error) {
      log(`browser relay failed: ${error instanceof Error ? error.message : "unknown"}`);
      return false;
    }
  };

  const push = (partial: Partial<typeof outbox>): void => {
    if (partial.attached) outbox.attached.push(...partial.attached);
    if (partial.detached) outbox.detached.push(...partial.detached);
    if (partial.sizes) outbox.sizes.push(...partial.sizes);
    if (partial.results) outbox.results.push(...partial.results);
    if (partial.events) { outbox.events.push(...partial.events); if (outbox.events.length >= RELAY_MAX_EVENTS) { flush(); return; } }
    scheduleFlush();
  };

  const dipBounds = (spec: DesktopBrowserView): { x: number; y: number; width: number; height: number } | null => {
    if (!spec.bounds) return null;
    const zoom = deps.zoomFactor();
    const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    return { x: Math.round(spec.bounds.x * factor), y: Math.round(spec.bounds.y * factor), width: Math.max(0, Math.round(spec.bounds.width * factor)), height: Math.max(0, Math.round(spec.bounds.height * factor)) };
  };

  const place = (entry: LiveView): void => {
    const window = deps.window();
    if (!window || window.isDestroyed()) return;
    const bounds = dipBounds(entry.spec);
    const visible = entry.spec.visible && bounds !== null && bounds.width > 0 && bounds.height > 0;
    if (bounds && (entry.lastBounds === null || entry.lastBounds.x !== bounds.x || entry.lastBounds.y !== bounds.y || entry.lastBounds.width !== bounds.width || entry.lastBounds.height !== bounds.height)) {
      entry.view.setBounds(bounds);
      entry.lastBounds = bounds;
      push({ sizes: [{ viewId: entry.spec.id, width: bounds.width, height: bounds.height, scale: deps.scaleFactor() }] });
    }
    entry.view.setVisible(visible);
  };

  const create = (spec: DesktopBrowserView): void => {
    const window = deps.window();
    if (!window || window.isDestroyed()) return;
    const view = deps.createView(spec.partition);
    const entry: LiveView = { view, spec, attached: false, lastBounds: null };
    live.set(spec.id, entry);
    const contents = view.webContents;
    window.contentView.addChildView(view);
    view.setVisible(false);
    // 페이지가 새 창을 열려 하면 같은 뷰에서 연다 — 이 뷰 밖으로 나가는 창은 없다.
    contents.setWindowOpenHandler(({ url }) => { void contents.loadURL(url).catch(() => undefined); return { action: "deny" }; });
    contents.on("render-process-gone", () => drop(spec.id, true));
    contents.on("destroyed", () => drop(spec.id, true));
    try {
      contents.debugger.attach("1.3");
      contents.debugger.on("message", (_event, method, params, sessionId) => {
        // 하위 타깃(iframe·워커)의 세션 이벤트는 콘솔이 다루지 않는다 — 페이지 세션의 것만 올린다.
        if (sessionId) return;
        push({ events: [{ viewId: spec.id, method, params: (params ?? {}) as Record<string, unknown> }] });
      });
      contents.debugger.on("detach", (_event, reason) => { log(`browser view debugger detached: ${reason}`); drop(spec.id, true); });
      entry.attached = true;
      push({ attached: [spec.id] });
    } catch (error) {
      log(`browser view debugger attach failed: ${error instanceof Error ? error.message : "unknown"}`);
      drop(spec.id, true);
      return;
    }
    void contents.loadURL(spec.url).catch(() => undefined);
    place(entry);
  };

  const drop = (id: string, report: boolean): void => {
    const entry = live.get(id);
    if (!entry) return;
    live.delete(id);
    const window = deps.window();
    try { if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view); } catch { /* 창이 먼저 닫혔다. */ }
    try { if (entry.view.webContents.debugger.isAttached()) entry.view.webContents.debugger.detach(); } catch { /* 이미 떨어졌다. */ }
    try { entry.view.webContents.close(); } catch { /* 이미 죽은 렌더러. */ }
    if (report) push({ detached: [id] });
  };

  const run = (command: DesktopBrowserSnapshot["commands"][number]): void => {
    if (executed.has(command.id)) return;
    executed.add(command.id);
    // 기억은 유한하다 — 오래된 id 는 잊는다(콘솔은 결과를 받은 명령을 스냅샷에서 뺀다).
    if (executed.size > 10_000) for (const id of [...executed].slice(0, 5_000)) executed.delete(id);
    const entry = live.get(command.viewId);
    if (!entry || !entry.attached) { push({ results: [{ id: command.id, error: "desktop_view_missing" }] }); return; }
    entry.view.webContents.debugger.sendCommand(command.method, command.params)
      .then((result) => push({ results: [{ id: command.id, result }] }))
      .catch((error: unknown) => push({ results: [{ id: command.id, error: error instanceof Error ? error.message : "desktop_command_failed" }] }));
  };

  const apply = (snapshot: DesktopBrowserSnapshot): void => {
    if (snapshot.generation < generation) return;
    generation = snapshot.generation;
    const wanted = new Set(snapshot.views.map((view) => view.id));
    for (const id of [...live.keys()]) if (!wanted.has(id)) drop(id, false);
    for (const spec of snapshot.views) {
      const entry = live.get(spec.id);
      if (!entry) { create(spec); continue; }
      (entry as { spec: DesktopBrowserView }).spec = spec;
      place(entry);
    }
    for (const command of snapshot.commands) run(command);
  };

  const stream: DesktopEventStream = createDesktopEventStream<DesktopBrowserSnapshot>({
    snapshotPath: DESKTOP_BROWSER_PATH,
    eventsPath: DESKTOP_BROWSER_EVENTS_PATH,
    eventName: DESKTOP_BROWSER_EVENT,
    parseSnapshot: (value) => (isDesktopBrowserSnapshot(value) ? value : null),
    apply,
    maxFrameChars: MAX_DESKTOP_BROWSER_SSE_BUFFER_CHARS,
    normalizeOrigin: (value) => normalizeAnyConsoleOrigin(value, "desktop_browser_origin_invalid"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  return {
    async start(target: string): Promise<void> {
      stop();
      origin = normalizeAnyConsoleOrigin(target, "desktop_browser_origin_invalid");
      // 누구인지 먼저 알린다 — 콘솔이 UA 를 이 Chromium 의 것으로 맞춘다.
      await send(origin, { hello: { product: deps.product(), userAgent: deps.userAgent() } });
      await stream.start(origin);
    },
    stop,
    refresh(): void { for (const entry of live.values()) place(entry); },
  };

  function stop(): void {
    stream.stop();
    for (const id of [...live.keys()]) drop(id, false);
    executed.clear();
    generation = -1;
    outbox = emptyOutbox();
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    origin = null;
  }
}
