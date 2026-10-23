import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { BrowserPolicyError, GLOBAL_BROWSER_OWNER_ID, type BrowserService } from "./service.js";
import { writeImageToClipboard } from "./clipboard.js";

export interface BrowserSetShortcutsInput {
  readonly shortcuts: readonly string[];
}

interface BrowserRouteDeps {
  readonly browserService: BrowserService;
  readonly browserMcp: {
    interruptObjective(id: string): number;
    pasteIntoTerminal(id: string): boolean;
    resolveSessionOwner?(pluginId: string, scopeId: string): string | null;
    isSessionOwner?(id: string): boolean;
  };
  readonly objectiveRecords: { get(id: string): { id: string; [key: string]: unknown } | null };
  /** 자식 세션 → 브라우저의 주인(루트). 자식 세션은 자기 브라우저를 갖지 않고 루트의 것을 함께 쓴다. 없으면 자기 자신이다. */
  readonly browserOwnerOf?: (objectiveId: string) => string | null;
  readonly isWriteAdmitted: (req: IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: IncomingMessage) => boolean;
  readonly writeJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T | null>;
  readonly readUrl: (req: IncomingMessage) => URL;
  readonly withSecurityHeaders: (headers: OutgoingHttpHeaders) => OutgoingHttpHeaders;
}

const BROWSER_PASTE_MAX_BYTES = 48 * 1024 * 1024;

export function createBrowserRouter(deps: BrowserRouteDeps): RouteHandler {
  const { browserService, browserMcp, objectiveRecords, isWriteAdmitted, isExactConsoleOrigin, writeJson, readJsonBody, readUrl, withSecurityHeaders } = deps;
  return async ({ req, res, pathname }) => {
    if (!isWriteAdmitted(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/browser") { writeJson(res, 200, browserService.status()); return true; }
    if (req.method === "GET" && pathname === "/api/v1/browser/sessions/resolve") {
      const query = readUrl(req).searchParams;
      const ownerId = browserMcp.resolveSessionOwner?.(query.get("pluginId") ?? "", query.get("scopeId") ?? "") ?? null;
      writeJson(res, 200, { ownerId });
      return true;
    }
    if (req.method === "GET" && pathname === "/api/v1/browser/import-sources") {
      if (!browserService.available()) { writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() }); return true; }
      try { writeJson(res, 200, await browserService.importSources()); }
      catch (error) { writeJson(res, 500, { error: "browser_request_failed", message: error instanceof Error ? error.message : "browser_request_failed" }); }
      return true;
    }
    if (pathname === "/api/v1/browser/default-profile") {
      // Console 전체의 설정이라 Objective 아래가 아니다. 엔진이 없어도 정할 수 있다 — 다음 Objective 을 위한 값이다.
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body || (body.profile !== null && typeof body.profile !== "string")) { writeJson(res, 400, { error: "invalid_request" }); return true; }
      try { writeJson(res, 200, { defaultProfile: browserService.setDefaultProfile(body.profile) }); }
      catch (error) {
        if (error instanceof BrowserPolicyError) writeJson(res, 400, { error: error.code, message: error.message });
        else writeJson(res, 500, { error: "browser_request_failed" });
      }
      return true;
    }
    if (pathname === "/api/v1/browser/shortcuts") {
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body || !Array.isArray(body.shortcuts) || !body.shortcuts.every((item) => typeof item === "string")) {
        writeJson(res, 400, { error: "invalid_request" }); return true;
      }
      browserService.setShortcuts(body.shortcuts);
      writeJson(res, 200, { ok: true, shortcuts: body.shortcuts });
      return true;
    }
    const match = /^\/api\/v1\/browser\/objectives\/([^/]+)\/(state|screenshot|tabs|navigate|viewport|interrupt|inspect|paste|favicon|place|import|profile|clear-profile)$/u.exec(pathname);
    if (!match) { writeJson(res, 404, { error: "not_found" }); return true; }
    const requestedId = decodeURIComponent(match[1] ?? "");
    const action = match[2] ?? "";
    // 예약 id "global" 은 Objective 경로로도 열리지 않는다. 옛 전역 요청이 Session 에 붙지 않게 한다.
    const requested = requestedId === GLOBAL_BROWSER_OWNER_ID ? null : objectiveRecords.get(requestedId);
    // 자식 세션의 경로는 루트의 브라우저로 간다 — 상태·탭·중단이 모두 그 하나에 선다.
    const objectiveId = requested ? deps.browserOwnerOf?.(requested.id) ?? requested.id : requestedId;
    const objectiveRecord = requested ? objectiveRecords.get(objectiveId) : null;
    const sessionOwner = objectiveId !== GLOBAL_BROWSER_OWNER_ID && browserMcp.isSessionOwner?.(objectiveId) === true;
    if (!objectiveRecord && !sessionOwner) { writeJson(res, 404, { error: "objectiveRecord_not_found" }); return true; }
    // 상태는 쓸 수 없을 때도 답한다 — 패널이 왜 닫혀 있는지 그 답으로 듣는다.
    if (action !== "state" && !browserService.available()) { writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() }); return true; }
    const fail = (error: unknown) => {
      if (error instanceof BrowserPolicyError) { writeJson(res, 400, { error: error.code, message: error.message, ...error.detail }); return; }
      const message = error instanceof Error ? error.message : "browser_request_failed";
      writeJson(res, 500, { error: message.startsWith("browser_") ? message : "browser_request_failed" });
    };
    if (req.method === "GET" && action === "state") {
      // 뒤따르는 변화는 Objective 스트림의 browser:state 로 간다 — 이 답은 그 스트림에 붙는 화면의 출발점이다.
      writeJson(res, 200, browserService.state(objectiveId));
      return true;
    }
    if (req.method === "GET" && action === "favicon") {
      const tabId = readUrl(req).searchParams.get("tabId") ?? "";
      const icon = await browserService.favicon(objectiveId, tabId).catch(() => null);
      if (!icon) { writeJson(res, 404, { error: "not_found" }); return true; }
      res.writeHead(200, withSecurityHeaders({ "Content-Type": icon.type, "Cache-Control": "private, max-age=3600", "Content-Length": String(icon.body.byteLength) }));
      res.end(icon.body);
      return true;
    }
    if (req.method === "GET" && action === "screenshot") {
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", onClose);
      try {
        writeJson(res, 200, await browserService.screenshot(objectiveId, { format: "png", signal: controller.signal }));
      } catch (error) {
        if (!res.writableEnded && !res.destroyed) fail(error);
      } finally {
        res.off("close", onClose);
      }
      return true;
    }
    if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
    const body = await readJsonBody<Record<string, unknown>>(req, action === "paste" ? BROWSER_PASTE_MAX_BYTES : undefined);
    if (!body) { writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      if (action === "import") {
        if (typeof body.profileId !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, await browserService.importFromChrome(objectiveId, body.profileId)); return true;
      }
      if (action === "profile") {
        if (body.profile !== null && typeof body.profile !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, await browserService.setProfile(objectiveId, body.profile)); return true;
      }
      if (action === "clear-profile") {
        if (typeof body.profile !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        await browserService.clearProfile(body.profile);
        writeJson(res, 200, { cleared: body.profile }); return true;
      }
      if (action === "tabs") {
        const tabId = typeof body.tabId === "string" ? body.tabId : null;
        if (body.action === "create") { const tab = await browserService.createTab(objectiveId, typeof body.url === "string" ? body.url : null, "user"); writeJson(res, 200, { tab }); return true; }
        if (body.action === "close" && tabId) { await browserService.closeTab(objectiveId, tabId); writeJson(res, 200, { closed: tabId }); return true; }
        if (body.action === "select" && tabId) { await browserService.selectTab(objectiveId, tabId); writeJson(res, 200, { selected: tabId }); return true; }
        writeJson(res, 400, { error: "invalid_request" }); return true;
      }
      if (action === "navigate") {
        if (typeof body.url !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, await browserService.navigate(objectiveId, body.url, "user", typeof body.tabId === "string" ? body.tabId : null)); return true;
      }
      if (action === "viewport") {
        const preset = body.preset === "responsive" || body.preset === "mobile" || body.preset === "tablet" ? body.preset : undefined;
        const colorScheme = body.colorScheme === "light" || body.colorScheme === "dark" ? body.colorScheme : body.colorScheme === null ? null : undefined;
        writeJson(res, 200, { viewport: await browserService.setViewport(objectiveId, { preset, width: typeof body.width === "number" ? body.width : undefined, height: typeof body.height === "number" ? body.height : undefined, colorScheme }, "user") }); return true;
      }
      if (action === "interrupt") { writeJson(res, 200, { interrupted: browserMcp.interruptObjective(objectiveId) }); return true; }
      if (action === "place") {
        const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
        const x = num(body.x), y = num(body.y), width = num(body.width), height = num(body.height);
        if (body.visible === false && x === null) { browserService.place(objectiveId, null); writeJson(res, 200, { ok: true }); return true; }
        if (x === null || y === null || width === null || height === null || width < 0 || height < 0) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        browserService.place(objectiveId, { bounds: { x, y, width, height }, visible: body.visible !== false });
        writeJson(res, 200, { ok: true }); return true;
      }
      if (action === "inspect") {
        if (typeof body.x !== "number" || typeof body.y !== "number") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, { element: await browserService.inspectAt(objectiveId, body.x, body.y, typeof body.tabId === "string" ? body.tabId : null) }); return true;
      }
      if (action === "paste") {
        // 사람이 패널에서 만든 스크린샷을 이 기계의 OS 클립보드에 올린 뒤 터미널 Objective 의 CLI 에 붙여넣기(Ctrl+V)를
        // 눌러 준다 — CLI 는 자기가 도는 기계의 클립보드를 읽으므로, 서버가 올리고 나서야 키를 보내야 순서가 맞는다.
        if (!objectiveRecord) { writeJson(res, 409, { error: "terminal_not_running" }); return true; }
        if (objectiveRecord.chatMode === true) { writeJson(res, 409, { error: "objectiveRecord_in_chat_mode" }); return true; }
        if (typeof body.data !== "string" || body.data.length === 0) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        const png = Buffer.from(body.data, "base64");
        if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        try { await writeImageToClipboard(png); }
        catch (error) { process.stdout.write(`[fleet-browser] paste: clipboard write failed: ${error instanceof Error ? error.message : "unknown"}\n`); writeJson(res, 500, { error: "clipboard_failed" }); return true; }
        if (!browserMcp.pasteIntoTerminal(objectiveId)) { writeJson(res, 409, { error: "terminal_not_running" }); return true; }
        writeJson(res, 200, { pasted: true }); return true;
      }
      writeJson(res, 404, { error: "not_found" });
    } catch (error) { fail(error); }
    return true;
  };
}
