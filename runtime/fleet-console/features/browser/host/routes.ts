import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { BrowserPolicyError, type BrowserService } from "./service.js";
import { writeImageToClipboard } from "./clipboard.js";

interface BrowserRouteDeps {
  readonly browserService: BrowserService;
  readonly browserMcp: { interruptOperation(id: string): number; pasteIntoTerminal(id: string): boolean };
  readonly operations: { list(): readonly { id: string; payload: Record<string, unknown> }[] };
  readonly isWriteAdmitted: (req: IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: IncomingMessage) => boolean;
  readonly writeJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T | null>;
  readonly readUrl: (req: IncomingMessage) => URL;
  readonly withSecurityHeaders: (headers: OutgoingHttpHeaders) => OutgoingHttpHeaders;
}

const BROWSER_PASTE_MAX_BYTES = 48 * 1024 * 1024;

export function createBrowserRouter(deps: BrowserRouteDeps): RouteHandler {
  const { browserService, browserMcp, operations, isWriteAdmitted, isExactConsoleOrigin, writeJson, readJsonBody, readUrl, withSecurityHeaders } = deps;
  return async ({ req, res, pathname }) => {
    if (!isWriteAdmitted(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/browser") { writeJson(res, 200, browserService.status()); return true; }
    if (req.method === "GET" && pathname === "/api/v1/browser/import-sources") {
      if (!browserService.available()) { writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() }); return true; }
      try { writeJson(res, 200, await browserService.importSources()); }
      catch (error) { writeJson(res, 500, { error: "browser_request_failed", message: error instanceof Error ? error.message : "browser_request_failed" }); }
      return true;
    }
    const match = /^\/api\/v1\/browser\/operations\/([^/]+)\/(state|screenshot|tabs|navigate|viewport|interrupt|inspect|paste|favicon|place|import|profile|clear-profile)$/u.exec(pathname);
    if (!match) { writeJson(res, 404, { error: "not_found" }); return true; }
    const operationId = decodeURIComponent(match[1] ?? "");
    const action = match[2] ?? "";
    if (!operations.list().some((operation) => operation.id === operationId)) { writeJson(res, 404, { error: "operation_not_found" }); return true; }
    // 상태는 쓸 수 없을 때도 답한다 — 패널이 왜 닫혀 있는지 그 답으로 듣는다.
    if (action !== "state" && !browserService.available()) { writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() }); return true; }
    const fail = (error: unknown) => {
      if (error instanceof BrowserPolicyError) { writeJson(res, 400, { error: error.code, message: error.message, ...error.detail }); return; }
      const message = error instanceof Error ? error.message : "browser_request_failed";
      writeJson(res, 500, { error: message.startsWith("browser_") ? message : "browser_request_failed" });
    };
    if (req.method === "GET" && action === "state") {
      // 뒤따르는 변화는 Operation 스트림의 browser:state 로 간다 — 이 답은 그 스트림에 붙는 화면의 출발점이다.
      writeJson(res, 200, browserService.state(operationId));
      return true;
    }
    if (req.method === "GET" && action === "favicon") {
      const tabId = readUrl(req).searchParams.get("tabId") ?? "";
      const icon = await browserService.favicon(operationId, tabId).catch(() => null);
      if (!icon) { writeJson(res, 404, { error: "not_found" }); return true; }
      res.writeHead(200, withSecurityHeaders({ "Content-Type": icon.type, "Cache-Control": "private, max-age=3600", "Content-Length": String(icon.body.byteLength) }));
      res.end(icon.body);
      return true;
    }
    if (req.method === "GET" && action === "screenshot") {
      try { writeJson(res, 200, await browserService.screenshot(operationId, { format: "png" })); } catch (error) { fail(error); }
      return true;
    }
    if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
    const body = await readJsonBody<Record<string, unknown>>(req, action === "paste" ? BROWSER_PASTE_MAX_BYTES : undefined);
    if (!body) { writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      if (action === "import") {
        if (typeof body.profileId !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, await browserService.importFromChrome(operationId, body.profileId)); return true;
      }
      if (action === "profile") {
        if (body.profile !== null && typeof body.profile !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, await browserService.setProfile(operationId, body.profile)); return true;
      }
      if (action === "clear-profile") {
        if (typeof body.profile !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        await browserService.clearProfile(body.profile);
        writeJson(res, 200, { cleared: body.profile }); return true;
      }
      if (action === "tabs") {
        const tabId = typeof body.tabId === "string" ? body.tabId : null;
        if (body.action === "create") { const tab = await browserService.createTab(operationId, typeof body.url === "string" ? body.url : null, "user"); writeJson(res, 200, { tab }); return true; }
        if (body.action === "close" && tabId) { await browserService.closeTab(operationId, tabId); writeJson(res, 200, { closed: tabId }); return true; }
        if (body.action === "select" && tabId) { await browserService.selectTab(operationId, tabId); writeJson(res, 200, { selected: tabId }); return true; }
        writeJson(res, 400, { error: "invalid_request" }); return true;
      }
      if (action === "navigate") {
        if (typeof body.url !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, await browserService.navigate(operationId, body.url, "user", typeof body.tabId === "string" ? body.tabId : null)); return true;
      }
      if (action === "viewport") {
        const preset = body.preset === "responsive" || body.preset === "mobile" || body.preset === "tablet" ? body.preset : undefined;
        const colorScheme = body.colorScheme === "light" || body.colorScheme === "dark" ? body.colorScheme : body.colorScheme === null ? null : undefined;
        writeJson(res, 200, { viewport: await browserService.setViewport(operationId, { preset, width: typeof body.width === "number" ? body.width : undefined, height: typeof body.height === "number" ? body.height : undefined, colorScheme }, "user") }); return true;
      }
      if (action === "interrupt") { writeJson(res, 200, { interrupted: browserMcp.interruptOperation(operationId) }); return true; }
      if (action === "place") {
        const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
        const x = num(body.x), y = num(body.y), width = num(body.width), height = num(body.height);
        if (body.visible === false && x === null) { browserService.place(operationId, null); writeJson(res, 200, { ok: true }); return true; }
        if (x === null || y === null || width === null || height === null || width < 0 || height < 0) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        browserService.place(operationId, { bounds: { x, y, width, height }, visible: body.visible !== false });
        writeJson(res, 200, { ok: true }); return true;
      }
      if (action === "inspect") {
        if (typeof body.x !== "number" || typeof body.y !== "number") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, { element: await browserService.inspectAt(operationId, body.x, body.y, typeof body.tabId === "string" ? body.tabId : null) }); return true;
      }
      if (action === "paste") {
        // 사람이 패널에서 만든 스크린샷을 이 기계의 OS 클립보드에 올린 뒤 터미널 Operation 의 CLI 에 붙여넣기(Ctrl+V)를
        // 눌러 준다 — CLI 는 자기가 도는 기계의 클립보드를 읽으므로, 서버가 올리고 나서야 키를 보내야 순서가 맞는다.
        const node = operations.list().find((operation) => operation.id === operationId);
        if (node?.payload.chatMode === true) { writeJson(res, 409, { error: "operation_in_chat_mode" }); return true; }
        if (typeof body.data !== "string" || body.data.length === 0) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        const png = Buffer.from(body.data, "base64");
        if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        try { await writeImageToClipboard(png); }
        catch (error) { process.stdout.write(`[fleet-browser] paste: clipboard write failed: ${error instanceof Error ? error.message : "unknown"}\n`); writeJson(res, 500, { error: "clipboard_failed" }); return true; }
        if (!browserMcp.pasteIntoTerminal(operationId)) { writeJson(res, 409, { error: "terminal_not_running" }); return true; }
        writeJson(res, 200, { pasted: true }); return true;
      }
      writeJson(res, 404, { error: "not_found" });
    } catch (error) { fail(error); }
    return true;
  };
}
