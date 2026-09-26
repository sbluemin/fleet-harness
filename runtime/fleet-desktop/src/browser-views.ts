import type { WebContentsView } from "electron";
import {
  DESKTOP_BROWSER_EVENT,
  DESKTOP_BROWSER_EVENTS_PATH,
  DESKTOP_BROWSER_PATH,
  DESKTOP_BROWSER_RELAY_PATH,
  DESKTOP_BROWSER_SHELL_VIEW,
  isDesktopBrowserSnapshot,
  type DesktopBrowserRelay,
  type DesktopBrowserSnapshot,
  type DesktopBrowserView,
} from "@fleet-console/protocol/desktop";

import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream, type DesktopEventStream } from "./desktop-event-stream.js";
import { defaultParkViewport, parkedNativeBounds, type DesktopShellWindow, type ParkViewport } from "./shell-window.js";

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
  readonly shell: () => DesktopShellWindow | null;
  /** `profile` 이 있으면 그 영속 프로필의 디스크 세션에, `null` 이면 `partition` 의 메모리 세션에 뷰를 연다. */
  readonly createView: (partition: string, profile: string | null) => WebContentsView;
  /** 콘솔 창 렌더러의 줌 배율 — 패널이 알린 CSS px 를 DIP 로 바꾼다. */
  readonly zoomFactor: () => number;
  /** 뷰가 놓인 화면의 배율 — 콘솔이 스크린샷 픽셀을 CSS px 로 되돌릴 때 쓴다. */
  readonly scaleFactor: () => number;
  readonly product: () => string;
  readonly userAgent: () => string;
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  /**
   * 뷰가 아니라 셸에게 묻는 명령(`Fleet.*`) — 이 기계의 Chrome 프로필을 세고 그 쿠키를 세션 파티션에 넣는 일처럼
   * 창을 든 기계에서만 답할 수 있는 것. 없으면 그런 명령은 `desktop_shell_unsupported` 로 거절된다.
   */
  readonly shellCommand?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /**
   * 뷰 표면 PNG 에서 `crop`(이미지 픽셀)을 잘라 `size` 로 줄이고 요청 형식의 base64 로 돌려준다. 있으면 clip 이 붙은
   * `Page.captureScreenshot` 을 Chromium 의 캡처 에뮬레이션 없이 수행한다 — 없으면 명령을 그대로 보낸다.
   */
  readonly resampleCapture?: (png: Buffer, crop: CaptureRect, size: { width: number; height: number }, format: "png" | "jpeg", quality: number) => string;
}

export interface CaptureRect { x: number; y: number; width: number; height: number }

/** CDP 가 jpeg quality 를 받지 않았을 때 Chromium 이 쓰는 값. */
const DEFAULT_JPEG_QUALITY = 80;

interface ViewportCapture { readonly clip: CaptureRect; readonly scale: number; readonly format: "png" | "jpeg"; readonly quality: number }

/**
 * clip 이 붙은 캡처를 셸이 대신 풀 수 있는 모양인지. 전체 페이지(captureBeyondViewport)나 nativeImage 가 쓰지 못하는
 * 형식은 Chromium 에 그대로 맡긴다.
 */
function viewportCapture(params: Record<string, unknown>): ViewportCapture | null {
  if (params.captureBeyondViewport === true || params.fromSurface === false) return null;
  const format = params.format === undefined || params.format === "png" ? "png" : params.format === "jpeg" ? "jpeg" : null;
  if (!format) return null;
  const clip = params.clip as Record<string, unknown> | undefined;
  if (!clip || typeof clip !== "object") return null;
  const x = Number(clip.x), y = Number(clip.y), width = Number(clip.width), height = Number(clip.height);
  const scale = clip.scale === undefined ? 1 : Number(clip.scale);
  if (![x, y, width, height, scale].every(Number.isFinite) || width <= 0 || height <= 0 || scale <= 0) return null;
  const quality = typeof params.quality === "number" && Number.isFinite(params.quality) ? Math.min(100, Math.max(0, Math.round(params.quality))) : DEFAULT_JPEG_QUALITY;
  return { clip: { x, y, width, height }, scale, format, quality };
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
  /** 마지막 표시 크기 — 주차 중 창에 맞춘 일시적인 축소로 덮어쓰지 않는다. */
  parkViewport: ParkViewport;
  lastBounds: { x: number; y: number; width: number; height: number } | null;
}

/**
 * clip 을 Chromium 에 넘기면 캡처하는 동안 라이브 뷰에 디바이스 에뮬레이션(배율·viewport offset)이 걸린다 — 사람이 보고
 * 있는 뷰가 한두 프레임 축소된 페이지와 검은 바탕으로 깜빡이고, 스크롤한 페이지에서는 clip 이 문서 좌표로 읽혀 빈 프레임이
 * 나온다. 그래서 셸은 지금 그려진 표면을 clip 없이 받고, 콘솔이 뜻한 뷰포트 CSS 좌표의 clip 과 배율을 여기서 적용한다.
 */
async function captureWithoutEmulation(entry: LiveView, params: Record<string, unknown>, capture: ViewportCapture, resample: NonNullable<DesktopBrowserViewsDeps["resampleCapture"]>): Promise<{ data: string }> {
  const target = entry.view.webContents.debugger;
  type Box = { clientWidth?: number; clientHeight?: number };
  const metrics = await target.sendCommand("Page.getLayoutMetrics", {}) as { visualViewport?: Box; cssVisualViewport?: Box };
  // 이미지 픽셀 ÷ CSS px — 화면 배율·페이지 줌·프리셋 에뮬레이션을 모두 담는다. 두 값이 모두 스크롤바를 뺀 같은 상자다.
  const ratio = Number(metrics.visualViewport?.clientWidth) / Number(metrics.cssVisualViewport?.clientWidth);
  if (!Number.isFinite(ratio) || ratio <= 0) return await target.sendCommand("Page.captureScreenshot", params) as { data: string };
  const surface = await target.sendCommand("Page.captureScreenshot", { format: "png" }) as { data?: unknown };
  if (typeof surface.data !== "string") throw new Error("browser_capture_invalid_image");
  const png = Buffer.from(surface.data, "base64");
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("browser_capture_invalid_image");
  const imageWidth = png.readUInt32BE(16), imageHeight = png.readUInt32BE(20);
  const { clip } = capture;
  const left = Math.max(0, Math.min(imageWidth, Math.round(clip.x * ratio)));
  const top = Math.max(0, Math.min(imageHeight, Math.round(clip.y * ratio)));
  const crop = {
    x: left,
    y: top,
    width: Math.min(imageWidth, Math.round((clip.x + clip.width) * ratio)) - left,
    height: Math.min(imageHeight, Math.round((clip.y + clip.height) * ratio)) - top,
  };
  if (crop.width < 1 || crop.height < 1) throw new Error("browser_capture_outside_viewport");
  // Chromium 과 같은 결과 크기 — clip 의 CSS 크기 × 요청 배율 × 기기 배율.
  const size = { width: Math.max(1, Math.round(clip.width * capture.scale * ratio)), height: Math.max(1, Math.round(clip.height * capture.scale * ratio)) };
  return { data: resample(png, crop, size, capture.format, capture.quality) };
}

export function createDesktopBrowserViews(deps: DesktopBrowserViewsDeps): DesktopBrowserViews {
  const fetchFor = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? (() => {});
  const live = new Map<string, LiveView>();
  const executed = new Set<number>();
  let origin: string | null = null;
  /** start 마다 오른다 — 재시도 중인 배치가 옛 연결의 것인지 가리는 표. 같은 origin 으로 다시 붙어도 옛 배치는 버린다. */
  let session = 0;
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
    const token = session;
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
      while (session === token) {
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

  /** 콘솔 엔진은 attach 직후 viewSize 가 필요하다 — viewId 별 실제 DIP 만 올린다. */
  const reportSize = (viewId: string, bounds: { width: number; height: number }): void => {
    push({ sizes: [{ viewId, width: bounds.width, height: bounds.height, scale: deps.scaleFactor() }] });
  };

  const place = (entry: LiveView): void => {
    const shell = deps.shell();
    if (!shell || shell.isDestroyed()) return;
    const contentBounds = shell.stack.layoutConsole();
    const panelBounds = dipBounds(entry.spec);
    const hasPanelSize = panelBounds !== null && panelBounds.width > 0 && panelBounds.height > 0;
    // `visible` 은 사용자에게 보여 줄지(presentation)이지, 네이티브 setVisible 이 아니다.
    const presented = entry.spec.visible && hasPanelSize;
    if (presented && panelBounds) entry.parkViewport = { width: panelBounds.width, height: panelBounds.height };
    const nextBounds = presented && panelBounds
      ? panelBounds
      : parkedNativeBounds(entry.parkViewport, contentBounds);
    const boundsChanged = entry.lastBounds === null
      || entry.lastBounds.x !== nextBounds.x
      || entry.lastBounds.y !== nextBounds.y
      || entry.lastBounds.width !== nextBounds.width
      || entry.lastBounds.height !== nextBounds.height;
    const viewportChanged = entry.lastBounds === null
      || entry.lastBounds.width !== nextBounds.width
      || entry.lastBounds.height !== nextBounds.height;
    if (boundsChanged) {
      entry.view.setBounds(nextBounds);
      entry.lastBounds = nextBounds;
      // x/y-only parking moves must not bump Fleet.viewResized / geometry_version.
      if (viewportChanged) reportSize(entry.spec.id, nextBounds);
    }
    // 이 통합에서는 hidden/0×0 대신 visible + z-order parking — macOS CDP 실험에서 더 안정적이었다.
    entry.view.setVisible(true);
    const reclaimConsoleFocus = !presented && entry.view.webContents.isFocused();
    if (presented) shell.stack.presentBrowser(entry.view);
    else shell.stack.parkBrowser(entry.view);
    // Parked behind Console but still holding focus leaves keyboard input on an invisible page.
    if (reclaimConsoleFocus) {
      try { shell.consoleContents.focus(); } catch { /* window gone */ }
    }
  };

  const create = (spec: DesktopBrowserView): void => {
    const shell = deps.shell();
    if (!shell || shell.isDestroyed()) return;
    const view = deps.createView(spec.partition, spec.profile ?? null);
    const contentBounds = shell.stack.layoutConsole();
    const panelBounds = dipBounds(spec);
    const parkViewport = panelBounds && panelBounds.width > 0 && panelBounds.height > 0
      ? { width: panelBounds.width, height: panelBounds.height }
      : defaultParkViewport(contentBounds);
    const entry: LiveView = { view, spec, attached: false, parkViewport, lastBounds: null };
    live.set(spec.id, entry);
    const contents = view.webContents;
    const initialBounds = parkedNativeBounds(parkViewport, contentBounds);
    view.setBounds(initialBounds);
    entry.lastBounds = initialBounds;
    view.setVisible(true);
    shell.stack.parkBrowser(view);
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
      reportSize(spec.id, initialBounds);
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
    const shell = deps.shell();
    try { if (shell && !shell.isDestroyed()) shell.stack.removeBrowser(entry.view); } catch { /* 창이 먼저 닫혔다. */ }
    try { if (entry.view.webContents.debugger.isAttached()) entry.view.webContents.debugger.detach(); } catch { /* 이미 떨어졌다. */ }
    try { entry.view.webContents.close(); } catch { /* 이미 죽은 렌더러. */ }
    if (report) push({ detached: [id] });
  };

  const run = (command: DesktopBrowserSnapshot["commands"][number]): void => {
    if (executed.has(command.id)) return;
    executed.add(command.id);
    // 기억은 유한하다 — 오래된 id 는 잊는다(콘솔은 결과를 받은 명령을 스냅샷에서 뺀다).
    if (executed.size > 10_000) for (const id of [...executed].slice(0, 5_000)) executed.delete(id);
    if (command.viewId === DESKTOP_BROWSER_SHELL_VIEW) {
      const handler = deps.shellCommand;
      if (!handler) { push({ results: [{ id: command.id, error: "desktop_shell_unsupported" }] }); return; }
      // 셸 명령은 몇 초가 걸린다(헤드리스 Chrome). 그 사이 창이 다른 콘솔로 건너가면 이 답은 옛 콘솔의 것이라 버린다 —
      // 명령 id 는 콘솔마다 따로 매기므로 새 콘솔의 다른 명령을 엉뚱한 답으로 풀어 버릴 수 있다.
      const token = session;
      handler(command.method, command.params)
        .then((result) => { if (session === token) push({ results: [{ id: command.id, result }] }); })
        .catch((error: unknown) => { if (session === token) push({ results: [{ id: command.id, error: error instanceof Error ? error.message : "desktop_command_failed" }] }); });
      return;
    }
    const entry = live.get(command.viewId);
    if (!entry || !entry.attached) { push({ results: [{ id: command.id, error: "desktop_view_missing" }] }); return; }
    const capture = command.method === "Page.captureScreenshot" && deps.resampleCapture ? viewportCapture(command.params) : null;
    if (capture && deps.resampleCapture) {
      captureWithoutEmulation(entry, command.params, capture, deps.resampleCapture)
        .then((result) => push({ results: [{ id: command.id, result }] }))
        .catch((error: unknown) => push({ results: [{ id: command.id, error: error instanceof Error ? error.message : "desktop_command_failed" }] }));
      return;
    }
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
      session += 1;
      origin = normalizeAnyConsoleOrigin(target, "desktop_browser_origin_invalid");
      // 누구인지 먼저 알린다 — 콘솔이 UA 를 이 Chromium 의 것으로 맞춘다.
      await send(origin, { hello: { product: deps.product(), userAgent: deps.userAgent() } });
      await stream.start(origin);
    },
    stop,
    refresh(): void { for (const entry of live.values()) place(entry); },
  };

  function stop(): void {
    session += 1;
    stream.stop();
    for (const id of [...live.keys()]) drop(id, false);
    executed.clear();
    generation = -1;
    outbox = emptyOutbox();
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    origin = null;
  }
}
