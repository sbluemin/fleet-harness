import type * as http from "node:http";
import { DESKTOP_BROWSER_EVENT, DESKTOP_BROWSER_EVENTS_PATH, DESKTOP_BROWSER_FRAME_HEIGHT_HEADER, DESKTOP_BROWSER_FRAME_MAX_BYTES, DESKTOP_BROWSER_FRAME_PATH, DESKTOP_BROWSER_FRAME_WIDTH_HEADER, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_RELAY_PATH, DESKTOP_BROWSER_VIEW_HEADER, isDesktopBrowserRelay } from "@fleet-console/protocol/desktop";
import type { DesktopEngine } from "./desktop-engine.js";
import type { BrowserService } from "./service.js";

interface BrowserDesktopRouteDeps {
  readonly desktopEngine: DesktopEngine;
  readonly browserService: BrowserService;
  readonly desktopBrowserSseSubscribers: Map<http.ServerResponse, string>;
  /** 루프백이 아니면 엔진 채널은 존재하지 않는 것처럼 404. */
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  /**
   * 관리 Desktop 메인 프로세스인가. 락 토큰·소유자 헤더·브라우저 렌더러가 아님을 모두 본다.
   * `missing` 은 토큰이 없을 때(401), `forbidden` 은 토큰은 있으나 소유자·출처가 다를 때(403).
   */
  readonly managerGate: (req: http.IncomingMessage) => "ok" | "missing" | "forbidden";
  readonly readJsonBody: <T>(req: http.IncomingMessage, maxBytes?: number) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
  readonly withSecurityHeaders: (extra: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
  readonly encodeSseData: (event: string, payload: unknown) => string;
}
const DESKTOP_BROWSER_RELAY_MAX_BYTES = 64 * 1024 * 1024;
const MANAGER_OWNER = "manager";

export function createBrowserDesktopRouter(deps: BrowserDesktopRouteDeps) {
  const { desktopEngine, browserService, desktopBrowserSseSubscribers, isLoopbackListener, managerGate, readJsonBody, writeJson, writeNoContent, withSecurityHeaders, encodeSseData } = deps;
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    if (pathname !== DESKTOP_BROWSER_PATH && pathname !== DESKTOP_BROWSER_EVENTS_PATH && pathname !== DESKTOP_BROWSER_RELAY_PATH && pathname !== DESKTOP_BROWSER_FRAME_PATH) return false;
    if (!isLoopbackListener(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    const gate = managerGate(req);
    if (gate !== "ok") { writeJson(res, gate === "missing" ? 401 : 403, { error: gate === "missing" ? "unauthorized" : "forbidden" }); return true; }
    if (pathname === DESKTOP_BROWSER_FRAME_PATH) return acceptFrame(req, res);
    if (pathname === DESKTOP_BROWSER_RELAY_PATH) {
      if (req.method !== "POST") { writeJson(res, 405, { error: "Method not allowed" }); return true; }
      const body = await readJsonBody<unknown>(req, DESKTOP_BROWSER_RELAY_MAX_BYTES);
      if (!isDesktopBrowserRelay(body)) { writeJson(res, 400, { error: "invalid_desktop_browser_relay" }); return true; }
      desktopEngine.relay(MANAGER_OWNER, body);
      writeNoContent(res);
      return true;
    }
    if (req.method !== "GET") { writeJson(res, 405, { error: "Method not allowed" }); return true; }
    if (desktopEngine.currentHost !== MANAGER_OWNER) desktopEngine.setHost(MANAGER_OWNER);
    const snapshotFor = () => desktopEngine.snapshot();
    if (pathname === DESKTOP_BROWSER_PATH) { writeJson(res, 200, snapshotFor()); return true; }
    res.writeHead(200, withSecurityHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }));
    res.write(":connected\n\n");
    desktopEngine.subscriberOpened(MANAGER_OWNER);
    desktopBrowserSseSubscribers.set(res, MANAGER_OWNER);
    browserService.reconcile();
    res.write(encodeSseData(DESKTOP_BROWSER_EVENT, snapshotFor()));
    const keepalive = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(":keepalive\n\n"); }, 25_000);
    res.on("close", () => { clearInterval(keepalive); desktopBrowserSseSubscribers.delete(res); desktopEngine.subscriberClosed(MANAGER_OWNER); browserService.reconcile(); });
    return true;
  };

  async function acceptFrame(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "POST") { writeJson(res, 405, { error: "Method not allowed" }); return true; }
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !type.startsWith("image/jpeg")) { writeJson(res, 400, { error: "invalid_frame" }); return true; }
    const viewId = req.headers[DESKTOP_BROWSER_VIEW_HEADER];
    const width = headerInt(req, DESKTOP_BROWSER_FRAME_WIDTH_HEADER);
    const height = headerInt(req, DESKTOP_BROWSER_FRAME_HEIGHT_HEADER);
    if (typeof viewId !== "string" || !viewId || width === null || height === null) { writeJson(res, 400, { error: "invalid_frame" }); return true; }
    const bytes = await readRawBody(req, DESKTOP_BROWSER_FRAME_MAX_BYTES);
    if (!bytes || bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) { writeJson(res, 400, { error: "invalid_frame" }); return true; }
    if (!desktopEngine.ingestFrame(viewId, bytes, width, height)) { writeJson(res, 404, { error: "tab_not_found" }); return true; }
    writeNoContent(res);
    return true;
  }
}

function headerInt(req: http.IncomingMessage, name: string): number | null {
  const value = req.headers[name];
  if (typeof value !== "string" || !/^[0-9]{1,5}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 10000 ? parsed : null;
}

async function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) return null;
    chunks.push(buffer);
  }
  return chunks.length === 0 ? null : Buffer.concat(chunks);
}
