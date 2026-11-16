import {
  DESKTOP_BROWSER_FRAME_AT_HEADER,
  DESKTOP_BROWSER_FRAME_HEIGHT_HEADER,
  DESKTOP_BROWSER_FRAME_MAX_BYTES,
  DESKTOP_BROWSER_FRAME_SEQ_HEADER,
  DESKTOP_BROWSER_FRAME_WIDTH_HEADER,
  DESKTOP_BROWSER_VIEWER_STREAM_PATH,
  DESKTOP_BROWSER_VIEWER_QUALITY_PARAM,
  REMOTE_FRAME_STREAM_CONTENT_TYPE,
  createRemoteBrowserFrameDecoder,
  type RemoteBrowserDecodedFrame,
  type ViewerCaptureQuality,
} from "@fleet-console/protocol/desktop";

/**
 * 보기 전용 저지연 프레임 스트림 수신기 — 원격 조작 중 고빈도 프레임을 끊김 없이 받는다.
 *
 * - seq 단조 증가 검증: 구형 프레임은 버린다.
 * - 디코드·렌더 중 최신만 유지: 한 청크에서 여러 장이 풀리면 마지막 한 장만 그린다(큐 적체 방지).
 * - 스트림 끊김 시 지수 백오프 재연결 + 구형 Console(스트림 미지원) long-poll 폴백.
 */

const VIEWER_FRAME_PATH = "/api/v1/browser/viewer/frame";
const VIEWER_UNWATCH_PATH = "/api/v1/browser/viewer/unwatch";
const FRAME_WAIT_MS = 12_000;
const FRAME_RETRY_MS = 1_000;
const STREAM_RETRY_BASE_MS = 250;
const STREAM_RETRY_MAX_MS = 5_000;

export interface RemoteViewerStreamFrame {
  readonly seq: number;
  readonly at: number;
  readonly width: number;
  readonly height: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly jpeg: Buffer;
}

export interface RemoteBrowserViewerStreamDeps {
  readonly fetch: typeof fetch;
  readonly onFrame: (tabId: string, frame: RemoteViewerStreamFrame) => void;
  readonly log?: (message: string) => void;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  readonly maxFrameBytes?: number;
}

export interface RemoteBrowserViewerStream {
  /** 그 탭의 스트림을 연다 — 같은 탭·origin·화질이면 그대로 둔다. */
  watch(tabId: string, origin: string, quality: ViewerCaptureQuality): void;
  unwatch(): void;
  stop(): void;
}

export function createRemoteBrowserViewerStream(deps: RemoteBrowserViewerStreamDeps): RemoteBrowserViewerStream {
  const log = deps.log ?? (() => {});
  const schedule = deps.setTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = deps.clearTimeout ?? ((timer: unknown) => { clearTimeout(timer as ReturnType<typeof setTimeout>); });
  const maxFrameBytes = deps.maxFrameBytes ?? DESKTOP_BROWSER_FRAME_MAX_BYTES;

  let current: { readonly tabId: string; readonly origin: string; readonly quality: ViewerCaptureQuality; readonly controller: AbortController } | null = null;
  let timer: unknown = null;
  let retry = 0;
  /** 구형 Console 로 확인되면 이 origin 에서는 long-poll 만 쓴다. */
  let longPollOnly = false;
  let longPollOrigin: string | null = null;

  const clearTimer = (): void => {
    if (timer !== null) { cancel(timer); timer = null; }
  };

  const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    const handle = schedule(resolve, ms);
    timer = handle;
    signal.addEventListener("abort", () => { clearTimer(); resolve(); }, { once: true });
  });

  const backoff = (): number => Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** Math.min(5, retry));

  const notify = (tabId: string, decoded: RemoteBrowserDecodedFrame): void => {
    deps.onFrame(tabId, {
      seq: decoded.seq,
      at: decoded.at,
      width: decoded.width,
      height: decoded.height,
      cssWidth: decoded.cssWidth,
      cssHeight: decoded.cssHeight,
      jpeg: Buffer.from(decoded.jpeg),
    });
  };

  const runStream = async (tabId: string, origin: string, quality: ViewerCaptureQuality, controller: AbortController): Promise<void> => {
    const alive = (): boolean => current?.controller === controller && !controller.signal.aborted;
    let after = 0;
    retry = 0;
    while (alive() && !longPollOnly) {
      try {
        const response = await deps.fetch(
          `${origin}${DESKTOP_BROWSER_VIEWER_STREAM_PATH}?tabId=${encodeURIComponent(tabId)}&afterSeq=${after}&${DESKTOP_BROWSER_VIEWER_QUALITY_PARAM}=${quality}`,
          { headers: { Origin: origin }, signal: controller.signal, cache: "no-store" },
        );
        if (!alive()) return;
        // 구형 Console — 스트림 경로가 없다. long-poll 로 떨어진다.
        if (response.status === 404 || response.status === 405) {
          longPollOnly = true;
          longPollOrigin = origin;
          await response.arrayBuffer().catch(() => undefined);
          void runLongPoll(tabId, origin, quality, controller, after);
          return;
        }
        if (!response.ok || !response.body) {
          await response.arrayBuffer().catch(() => undefined);
          retry += 1;
          await pause(backoff(), controller.signal);
          continue;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.startsWith(REMOTE_FRAME_STREAM_CONTENT_TYPE)) {
          await response.arrayBuffer().catch(() => undefined);
          longPollOnly = true;
          longPollOrigin = origin;
          void runLongPoll(tabId, origin, quality, controller, after);
          return;
        }
        retry = 0;
        let pending: RemoteBrowserDecodedFrame | null = null;
        const feed = createRemoteBrowserFrameDecoder((frame) => {
          // seq 단조 증가 검증 — 구형 프레임 폐기.
          if (!Number.isFinite(frame.seq) || frame.seq <= after) return;
          after = frame.seq;
          // 최신만 유지 — 한 청크의 여러 장은 마지막 한 장으로 합친다.
          pending = frame;
        }, maxFrameBytes);
        const reader = response.body.getReader();
        try {
          for (;;) {
            if (!alive()) { try { await reader.cancel(); } catch { /* 이미 닫힘 */ } return; }
            const next = await reader.read();
            if (!alive()) { try { await reader.cancel(); } catch { /* 이미 닫힘 */ } return; }
            if (next.done) break;
            pending = null;
            try {
              feed(new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength));
            } catch (error) {
              log(`browser viewer stream decode failed: ${error instanceof Error ? error.message : "unknown"}`);
              break;
            }
            // 이 청크에서 풀린 최신 한 장만 렌더한다.
            if (pending !== null) notify(tabId, pending);
          }
        } finally {
          try { reader.releaseLock(); } catch { /* 이미 해제 */ }
        }
        if (!alive()) return;
        retry += 1;
        await pause(backoff(), controller.signal);
      } catch {
        if (!alive()) return;
        retry += 1;
        await pause(backoff(), controller.signal);
      }
    }
  };

  const runLongPoll = async (tabId: string, origin: string, quality: ViewerCaptureQuality, controller: AbortController, startAfter: number): Promise<void> => {
    const alive = (): boolean => current?.controller === controller && !controller.signal.aborted;
    let after = startAfter;
    while (alive()) {
      try {
        const response = await deps.fetch(
          `${origin}${VIEWER_FRAME_PATH}?tabId=${encodeURIComponent(tabId)}&afterSeq=${after}&waitMs=${FRAME_WAIT_MS}&${DESKTOP_BROWSER_VIEWER_QUALITY_PARAM}=${quality}`,
          { headers: { Origin: origin }, signal: controller.signal, cache: "no-store" },
        );
        if (!alive()) return;
        if (response.status === 204) continue;
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          await pause(FRAME_RETRY_MS, controller.signal);
          continue;
        }
        const seq = Number(response.headers.get(DESKTOP_BROWSER_FRAME_SEQ_HEADER) ?? "0");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!alive()) return;
        if (!Number.isFinite(seq) || seq <= after) continue;
        after = seq;
        if (bytes.length < 2 || bytes.length > DESKTOP_BROWSER_FRAME_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
        const width = Number(response.headers.get(DESKTOP_BROWSER_FRAME_WIDTH_HEADER) ?? "0");
        const height = Number(response.headers.get(DESKTOP_BROWSER_FRAME_HEIGHT_HEADER) ?? "0");
        const at = Number(response.headers.get(DESKTOP_BROWSER_FRAME_AT_HEADER) ?? "0");
        notify(tabId, {
          seq,
          at: Number.isFinite(at) ? at : Date.now(),
          width: Number.isFinite(width) ? width : 0,
          height: Number.isFinite(height) ? height : 0,
          cssWidth: Number.isFinite(width) ? width : 0,
          cssHeight: Number.isFinite(height) ? height : 0,
          jpeg: bytes,
        });
      } catch {
        if (!alive()) return;
        await pause(FRAME_RETRY_MS, controller.signal);
      }
    }
  };

  const stopCurrent = (notifyUnwatch: boolean): void => {
    const prev = current;
    current = null;
    clearTimer();
    if (prev) {
      prev.controller.abort();
      if (notifyUnwatch) {
        void deps.fetch(`${prev.origin}${VIEWER_UNWATCH_PATH}?tabId=${encodeURIComponent(prev.tabId)}`, {
          method: "POST",
          headers: { Origin: prev.origin },
        }).catch(() => undefined);
      }
    }
  };

  return {
    watch(tabId, origin, quality) {
      if (current && current.tabId === tabId && current.origin === origin && current.quality === quality) return;
      stopCurrent(false);
      if (longPollOnly && longPollOrigin !== origin) {
        longPollOnly = false;
        longPollOrigin = null;
      }
      const controller = new AbortController();
      current = { tabId, origin, quality, controller };
      if (longPollOnly && longPollOrigin === origin) void runLongPoll(tabId, origin, quality, controller, 0);
      else void runStream(tabId, origin, quality, controller).catch((error: unknown) => log(`browser viewer stream failed: ${error instanceof Error ? error.message : "unknown"}`));
    },
    unwatch() {
      stopCurrent(true);
    },
    stop() {
      stopCurrent(false);
      longPollOnly = false;
      longPollOrigin = null;
    },
  };
}
