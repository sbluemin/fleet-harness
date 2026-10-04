import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { BrowserPolicyError, GLOBAL_BROWSER_OWNER_ID, type BrowserService } from "./service.js";
import { writeImageToClipboard } from "./clipboard.js";

export interface BrowserGlobalTabsInput {
  readonly action: "create" | "open" | "close" | "select";
  readonly tabId?: string | null;
  readonly url?: string | null;
  readonly activate?: boolean;
}

export interface BrowserGlobalNavigateInput {
  readonly url: string;
  readonly tabId?: string | null;
}

export interface BrowserGlobalViewportInput {
  readonly preset?: "responsive" | "mobile" | "tablet";
  readonly width?: number;
  readonly height?: number;
  readonly colorScheme?: "light" | "dark" | null;
}

export interface BrowserGlobalPlaceInput {
  readonly x?: number | null;
  readonly y?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly visible?: boolean;
}

export interface BrowserSetShortcutsInput {
  readonly shortcuts: readonly string[];
}

interface BrowserRouteDeps {
  readonly browserService: BrowserService;
  readonly browserMcp: { interruptOperation(id: string): number; pasteIntoTerminal(id: string): boolean };
  readonly operations: { get(id: string): { id: string; payload: Record<string, unknown> } | null };
  readonly isWriteAdmitted: (req: IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: IncomingMessage) => boolean;
  readonly isDesktopHostClient?: (req: IncomingMessage) => boolean;
  readonly writeJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T | null>;
  readonly readUrl: (req: IncomingMessage) => URL;
  readonly withSecurityHeaders: (headers: OutgoingHttpHeaders) => OutgoingHttpHeaders;
}

const BROWSER_PASTE_MAX_BYTES = 48 * 1024 * 1024;

export function createBrowserRouter(deps: BrowserRouteDeps): RouteHandler {
  const { browserService, browserMcp, operations, isWriteAdmitted, isExactConsoleOrigin, isDesktopHostClient, writeJson, readJsonBody, readUrl, withSecurityHeaders } = deps;
  return async ({ req, res, pathname }) => {
    if (!isWriteAdmitted(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/browser") { writeJson(res, 200, browserService.status()); return true; }
    if (req.method === "GET" && pathname === "/api/v1/browser/import-sources") {
      if (!browserService.available()) { writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() }); return true; }
      try { writeJson(res, 200, await browserService.importSources()); }
      catch (error) { writeJson(res, 500, { error: "browser_request_failed", message: error instanceof Error ? error.message : "browser_request_failed" }); }
      return true;
    }
    if (pathname === "/api/v1/browser/default-profile") {
      // Console 전체의 설정이라 Operation 아래가 아니다. 엔진이 없어도 정할 수 있다 — 다음 Operation 을 위한 값이다.
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
    const globalMatch = /^\/api\/v1\/browser\/global\/(state|screenshot|tabs|navigate|viewport|inspect|favicon|place|profile|clear-profile|import|restore-closed-tabs|dismiss-closed-tabs)$/u.exec(pathname);
    if (globalMatch) {
      const action = globalMatch[1] ?? "";
      const isDesktop = isDesktopHostClient ? isDesktopHostClient(req) : true;
      // 가져오기는 사람의 Chrome 쿠키를 전역 탭 세션에 넣는 일이다 — 그 탭을 보는 Desktop 창에서만 연다.
      if (!isDesktop && (action === "restore-closed-tabs" || action === "dismiss-closed-tabs" || action === "screenshot" || action === "favicon" || action === "import")) {
        writeJson(res, 403, { error: "desktop_required" });
        return true;
      }
      if (action !== "state" && !browserService.available()) {
        writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() });
        return true;
      }
      const fail = (error: unknown) => {
        if (error instanceof BrowserPolicyError) { writeJson(res, 400, { error: error.code, message: error.message, ...error.detail }); return; }
        const message = error instanceof Error ? error.message : "browser_request_failed";
        writeJson(res, 500, { error: message.startsWith("browser_") ? message : "browser_request_failed" });
      };
      if (req.method === "GET" && action === "state") {
        const rawState = browserService.globalState();
        if (!isDesktop) {
          // 비-Desktop(웹 탭·휴대폰) 클라이언트에는 사람의 탭 목록과 닫힌 탭 복구 URL 을 비워서 돌려준다.
          writeJson(res, 200, {
            ...rawState,
            tabs: [],
            closedTabs: [],
            activeTabId: null,
            available: false,
            reason: rawState.reason ?? "desktop_required",
          });
          return true;
        }
        writeJson(res, 200, rawState);
        return true;
      }
      if (req.method === "GET" && action === "favicon") {
        if (!isDesktop) { writeJson(res, 403, { error: "desktop_required" }); return true; }
        const tabId = readUrl(req).searchParams.get("tabId") ?? "";
        const icon = await browserService.favicon(GLOBAL_BROWSER_OWNER_ID, tabId).catch(() => null);
        if (!icon) { writeJson(res, 404, { error: "not_found" }); return true; }
        res.writeHead(200, withSecurityHeaders({ "Content-Type": icon.type, "Cache-Control": "private, max-age=3600", "Content-Length": String(icon.body.byteLength) }));
        res.end(icon.body);
        return true;
      }
      if (req.method === "GET" && action === "screenshot") {
        if (!isDesktop) { writeJson(res, 403, { error: "desktop_required" }); return true; }
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on("close", onClose);
        try {
          // 시트 정지 화면만 `?resolution=device` 로 화면 배율 원본을 받는다 — 매개변수가 없으면 CSS px 크기 그대로다.
          const resolution = readUrl(req).searchParams.get("resolution") === "device" ? "device" : "css";
          writeJson(res, 200, await browserService.screenshot(GLOBAL_BROWSER_OWNER_ID, { format: "png", resolution, signal: controller.signal }));
        } catch (error) {
          if (!res.writableEnded && !res.destroyed) fail(error);
        } finally {
          res.off("close", onClose);
        }
        return true;
      }
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      if (!isDesktop && (action === "restore-closed-tabs" || action === "dismiss-closed-tabs")) {
        writeJson(res, 403, { error: "desktop_required" });
        return true;
      }
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body && action !== "restore-closed-tabs" && action !== "dismiss-closed-tabs") { writeJson(res, 400, { error: "invalid_request" }); return true; }
      try {
        if (action === "restore-closed-tabs") {
          const restored = await browserService.restoreClosedTabs();
          writeJson(res, 200, { ok: true, restored });
          return true;
        }
        if (action === "dismiss-closed-tabs") {
          browserService.dismissClosedTabs();
          writeJson(res, 200, { ok: true });
          return true;
        }
        if (action === "profile") {
          if (body && body.profile !== null && typeof body.profile !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
          writeJson(res, 200, await browserService.setProfile(GLOBAL_BROWSER_OWNER_ID, (body?.profile as string | null) ?? null));
          return true;
        }
        if (action === "import") {
          // 쿠키는 전역 소유자가 지금 쓰는 세션(임시 파티션 또는 영속 프로필)으로 간다. 탭이 없으면 그 세션을 먼저 만들고,
          // 다음에 여는 탭이 같은 세션을 쓴다 — Operation 경로와 같은 서비스 계약이다.
          if (!body || typeof body.profileId !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
          writeJson(res, 200, await browserService.importFromChrome(GLOBAL_BROWSER_OWNER_ID, body.profileId));
          return true;
        }
        if (action === "clear-profile") {
          if (!body || typeof body.profile !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
          await browserService.clearProfile(body.profile);
          writeJson(res, 200, { cleared: body.profile });
          return true;
        }
        if (action === "tabs") {
          const tabId = typeof body?.tabId === "string" ? body.tabId : null;
          if (body?.action === "create") { const tab = await browserService.createTab(GLOBAL_BROWSER_OWNER_ID, typeof body.url === "string" ? body.url : null, "user"); writeJson(res, 200, { tab }); return true; }
          if (body?.action === "open") {
            if (typeof body.url !== "string" || (body.activate !== undefined && typeof body.activate !== "boolean")) { writeJson(res, 400, { error: "invalid_request" }); return true; }
            const tab = await browserService.openGlobalUrl(body.url, { activate: body.activate !== false });
            writeJson(res, 200, { tab });
            return true;
          }
          if (body?.action === "close" && tabId) { await browserService.closeTab(GLOBAL_BROWSER_OWNER_ID, tabId); writeJson(res, 200, { closed: tabId }); return true; }
          if (body?.action === "select" && tabId) { await browserService.selectTab(GLOBAL_BROWSER_OWNER_ID, tabId); writeJson(res, 200, { selected: tabId }); return true; }
          writeJson(res, 400, { error: "invalid_request" }); return true;
        }
        if (action === "navigate") {
          if (!body || typeof body.url !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
          writeJson(res, 200, await browserService.navigate(GLOBAL_BROWSER_OWNER_ID, body.url, "user", typeof body.tabId === "string" ? body.tabId : null));
          return true;
        }
        if (action === "viewport") {
          const preset = body?.preset === "responsive" || body?.preset === "mobile" || body?.preset === "tablet" ? body.preset : undefined;
          const colorScheme = body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : body?.colorScheme === null ? null : undefined;
          writeJson(res, 200, { viewport: await browserService.setViewport(GLOBAL_BROWSER_OWNER_ID, { preset, width: typeof body?.width === "number" ? body.width : undefined, height: typeof body?.height === "number" ? body.height : undefined, colorScheme }, "user") });
          return true;
        }
        if (action === "place") {
          const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
          const x = num(body?.x), y = num(body?.y), width = num(body?.width), height = num(body?.height);
          if (body?.visible === false && x === null) { browserService.place(GLOBAL_BROWSER_OWNER_ID, null); writeJson(res, 200, { ok: true }); return true; }
          if (x === null || y === null || width === null || height === null || width < 0 || height < 0) { writeJson(res, 400, { error: "invalid_request" }); return true; }
          browserService.place(GLOBAL_BROWSER_OWNER_ID, { bounds: { x, y, width, height }, visible: body?.visible !== false });
          writeJson(res, 200, { ok: true }); return true;
        }
        if (action === "inspect") {
          if (!body || typeof body.x !== "number" || typeof body.y !== "number") { writeJson(res, 400, { error: "invalid_request" }); return true; }
          writeJson(res, 200, { element: await browserService.inspectAt(GLOBAL_BROWSER_OWNER_ID, body.x, body.y, typeof body.tabId === "string" ? body.tabId : null) });
          return true;
        }
        writeJson(res, 404, { error: "not_found" });
      } catch (error) { fail(error); }
      return true;
    }
    const match = /^\/api\/v1\/browser\/operations\/([^/]+)\/(state|screenshot|tabs|navigate|viewport|interrupt|inspect|paste|favicon|place|import|profile|clear-profile)$/u.exec(pathname);
    if (!match) { writeJson(res, 404, { error: "not_found" }); return true; }
    const operationId = decodeURIComponent(match[1] ?? "");
    const action = match[2] ?? "";
    // 전역 소유자 id는 Operation 경로로 열리지 않는다 — 전역 브라우저는 /global/* 로만 다룬다.
    const operation = operationId === GLOBAL_BROWSER_OWNER_ID ? null : operations.get(operationId);
    if (!operation) { writeJson(res, 404, { error: "operation_not_found" }); return true; }
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
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", onClose);
      try {
        writeJson(res, 200, await browserService.screenshot(operationId, { format: "png", signal: controller.signal }));
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
        if (operation.payload.chatMode === true) { writeJson(res, 409, { error: "operation_in_chat_mode" }); return true; }
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
