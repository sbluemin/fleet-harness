import type * as http from "node:http";
import { DESKTOP_BROWSER_EVENT, DESKTOP_BROWSER_EVENTS_PATH, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_RELAY_PATH, isDesktopBrowserRelay } from "@fleet-console/protocol/desktop";
import type { DesktopEngine } from "./desktop-engine.js";
import type { BrowserService } from "./service.js";

interface BrowserDesktopRouteDeps {
  readonly desktopEngine: DesktopEngine;
  readonly browserService: BrowserService;
  readonly desktopBrowserSseSubscribers: Map<http.ServerResponse, string>;
  readonly isExactConsoleOrigin: (req: http.IncomingMessage) => boolean;
  readonly shellOwnerOf: (req: http.IncomingMessage) => string | null;
  readonly readJsonBody: <T>(req: http.IncomingMessage, maxBytes?: number) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
  readonly withSecurityHeaders: (extra: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
  readonly encodeSseData: (event: string, payload: unknown) => string;
}
const DESKTOP_BROWSER_RELAY_MAX_BYTES = 64 * 1024 * 1024;
export function createBrowserDesktopRouter(deps: BrowserDesktopRouteDeps) {
  const { desktopEngine, browserService, desktopBrowserSseSubscribers, isExactConsoleOrigin, shellOwnerOf, readJsonBody, writeJson, writeNoContent, withSecurityHeaders, encodeSseData } = deps;
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    if (pathname !== DESKTOP_BROWSER_PATH && pathname !== DESKTOP_BROWSER_EVENTS_PATH && pathname !== DESKTOP_BROWSER_RELAY_PATH) return false;
    if (!isExactConsoleOrigin(req)) { writeJson(res, 401, { error: "unauthorized" }); return true; }
    const owner = shellOwnerOf(req);
    if (owner === null) { writeJson(res, 401, { error: "unauthorized" }); return true; }
    if (pathname === DESKTOP_BROWSER_RELAY_PATH) {
      if (req.method !== "POST") { writeJson(res, 405, { error: "Method not allowed" }); return true; }
      const body = await readJsonBody<unknown>(req, DESKTOP_BROWSER_RELAY_MAX_BYTES);
      if (!isDesktopBrowserRelay(body)) { writeJson(res, 400, { error: "invalid_desktop_browser_relay" }); return true; }
      desktopEngine.relay(owner, body);
      writeNoContent(res);
      return true;
    }
    if (req.method !== "GET") { writeJson(res, 405, { error: "Method not allowed" }); return true; }
    const snapshotFor = () => owner === desktopEngine.currentHost ? desktopEngine.snapshot() : desktopEngine.emptySnapshot();
    if (pathname === DESKTOP_BROWSER_PATH) { writeJson(res, 200, snapshotFor()); return true; }
    res.writeHead(200, withSecurityHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }));
    res.write(":connected\n\n");
    desktopEngine.subscriberOpened(owner);
    desktopBrowserSseSubscribers.set(res, owner);
    browserService.reconcile();
    res.write(encodeSseData(DESKTOP_BROWSER_EVENT, snapshotFor()));
    const keepalive = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(":keepalive\n\n"); }, 25_000);
    res.on("close", () => { clearInterval(keepalive); desktopBrowserSseSubscribers.delete(res); desktopEngine.subscriberClosed(owner); browserService.reconcile(); });
    return true;
  };
}
