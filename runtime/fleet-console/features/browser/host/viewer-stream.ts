import type * as http from "node:http";
import {
  DESKTOP_BROWSER_VIEWER_STREAM_PATH,
  DESKTOP_BROWSER_VIEWER_QUALITY_PARAM,
  REMOTE_FRAME_STREAM_CONTENT_TYPE,
  encodeRemoteBrowserFrame,
  viewerCaptureQualityOf,
  type BrowserExecutionHost,
} from "@fleet-console/protocol/desktop";
import type { DesktopEngine } from "./desktop-engine.js";
import type { BrowserService } from "./service.js";
import { BROWSER_GLOBAL_ID } from "../shared/browser-id.js";

/**
 * 보기 전용 저지연 프레임 스트림 — `GET /api/v1/browser/viewer/stream?tabId=&afterSeq=`.
 *
 * 기존 `/api/v1/browser/viewer/frame` long-poll 을 유지한 채, 바이너리 스트림
 * (`application/x-fleet-browser-stream`) 으로 같은 프레임을 끊김 없이 push 한다.
 * routes.ts 경합을 피하기 위해 분리했으며, 임무 7 에서 routes.ts 에 연결한다.
 */

export interface ViewerStreamDeps {
  readonly desktopEngine: DesktopEngine;
  readonly browserService: BrowserService;
  /** 보기 전용 프레임을 읽을 수 있는 세션인가. 아니면 401/403. */
  readonly viewerFrameRead: (req: http.IncomingMessage) => "ok" | "unauthorized" | "forbidden";
  readonly executionHost: () => BrowserExecutionHost;
  readonly withSecurityHeaders: (headers: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly readUrl: (req: http.IncomingMessage) => URL;
}

export function createViewerStreamHandler(deps: ViewerStreamDeps): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const { desktopEngine, browserService, viewerFrameRead, executionHost, withSecurityHeaders, writeJson, readUrl } = deps;
  return async (req, res): Promise<boolean> => {
    const url = readUrl(req);
    if (url.pathname !== DESKTOP_BROWSER_VIEWER_STREAM_PATH) return false;
    const admission = viewerFrameRead(req);
    if (admission !== "ok") {
      writeJson(res, admission === "unauthorized" ? 401 : 403, { error: admission === "unauthorized" ? "unauthorized" : "forbidden" });
      return true;
    }
    if ((req.method ?? "GET") !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    const host = executionHost();
    if (host.status !== "connected") {
      writeJson(res, 409, { error: "browser_unavailable", executionHost: host });
      return true;
    }
    const params = url.searchParams;
    const tabId = params.get("tabId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(tabId)) {
      writeJson(res, 400, { error: "invalid_request" });
      return true;
    }
    const viewId = browserService.viewIdOfTab(BROWSER_GLOBAL_ID, tabId);
    if (!viewId) {
      writeJson(res, 404, { error: "tab_not_found" });
      return true;
    }
    const rawAfter = Number(params.get("afterSeq") ?? "0");
    let after = Number.isFinite(rawAfter) && rawAfter >= 0 ? Math.floor(rawAfter) : 0;

    const release = desktopEngine.acquireWatch(viewId, { quality: viewerCaptureQualityOf(params.get(DESKTOP_BROWSER_VIEWER_QUALITY_PARAM)) });
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (lease: boolean): void => {
      if (settled) return;
      settled = true;
      try { unsubscribe?.(); } catch { /* 이미 끊긴 구독 */ }
      unsubscribe = null;
      try { release(lease); } catch { /* 엔진이 이미 닫힘 */ }
    };

    // watch ticket 유지 — 스트림이 살아 있는 동안 캡처가 멈추지 않는다.
    res.on("close", () => {
      if (!res.writableEnded) finish(false);
      else finish(true);
    });

    const writeFrame = async (seq: number, at: number, width: number, height: number, cssWidth: number, cssHeight: number, jpeg: Buffer): Promise<void> => {
      const encoded = encodeRemoteBrowserFrame({ seq, at, width, height, cssWidth, cssHeight }, jpeg);
      const chunk = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      if (res.writableEnded || res.destroyed) return;
      const ok = res.write(chunk);
      if (!ok) await new Promise<void>((resolve) => res.once("drain", () => resolve()));
    };

    type StreamFrame = { seq: number; at: number; width: number; height: number; cssWidth: number; cssHeight: number; bytes: Buffer };
    let writing = false;
    let pendingFrame: StreamFrame | null = null;
    let closedAfterWrite = false;
    let drainPromise: Promise<void> = Promise.resolve();
    const pump = async (): Promise<void> => {
      writing = true;
      try {
        while (pendingFrame !== null && !res.writableEnded && !res.destroyed) {
          const next = pendingFrame;
          pendingFrame = null;
          await writeFrame(next.seq, next.at, next.width, next.height, next.cssWidth, next.cssHeight, next.bytes);
        }
      } catch {
        /* 스트림 종료 */
      } finally {
        writing = false;
        if (closedAfterWrite) {
          if (!res.writableEnded && !res.destroyed) res.end();
          finish(false);
        }
      }
    };
    const push = (frame: StreamFrame): void => {
      if (frame.seq <= after) return;
      after = frame.seq;
      // 배압(drain 대기) 중 새 프레임이 오면 대기 중인 이전 프레임은 덮어써 메모리 적체와 지연을 막는다.
      pendingFrame = frame;
      if (!writing) drainPromise = pump();
    };

    unsubscribe = desktopEngine.subscribeStream(
      viewId,
      (frame) => push(frame),
      () => {
        if (writing) {
          closedAfterWrite = true;
          return;
        }
        void drainPromise.then(() => {
          if (!res.writableEnded && !res.destroyed) res.end();
          finish(false);
        }).catch(() => undefined);
      },
    );

    res.writeHead(
      200,
      withSecurityHeaders({
        "Content-Type": REMOTE_FRAME_STREAM_CONTENT_TYPE,
        "Cache-Control": "no-store",
      }),
    );

    // 구독 뒤 최신 한 장 — 재연결 직후 빈 구간 없이 잇는다.
    const latest = desktopEngine.frameIfNewer(viewId, after);
    if (latest) push(latest);

    // 이후 프레임은 subscribeStream push 로만 흐른다 — 폴링하지 않는다.
    // 종료는 res close(재연결은 lease 2.5s 로 잇는다) 또는 뷰 종료(onClosed)로만 난다.
    return true;
  };
}

/** 임무 7 통합용 — routes.ts 에서 `if (await serveViewerStream(req, res)) return true;` 로 잇는다. */
export async function serveViewerStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ViewerStreamDeps,
): Promise<boolean> {
  return createViewerStreamHandler(deps)(req, res);
}
