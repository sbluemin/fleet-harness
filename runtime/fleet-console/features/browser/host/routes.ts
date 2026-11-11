import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { DESKTOP_BROWSER_FRAME_AT_HEADER, DESKTOP_BROWSER_FRAME_HEIGHT_HEADER, DESKTOP_BROWSER_FRAME_SEQ_HEADER, DESKTOP_BROWSER_FRAME_WIDTH_HEADER, type BrowserExecutionHost, type BrowserSurfaceModeKind } from "@fleet-console/protocol/desktop";
import { BrowserPolicyError, GLOBAL_BROWSER_OWNER_ID, type BrowserService } from "./service.js";
import { ViewerFrameClosedError, ViewerFrameDisconnectedError, ViewerFrameTimeoutError, type DesktopEngine } from "./desktop-engine.js";
import { BROWSER_GLOBAL_ID } from "../shared/browser-id.js";
import { writeImageToClipboard } from "./clipboard.js";
import { DEFAULT_BROWSER_SUGGESTION_SETTINGS, suggestionSkipReason, type BrowserSuggestionSettings } from "../shared/suggestions.js";

export interface BrowserSetShortcutsInput {
  readonly shortcuts: readonly string[];
}

interface BrowserRouteDeps {
  readonly browserService: BrowserService;
  readonly desktopEngine: DesktopEngine;
  readonly suggestionSettings?: {
    read(): BrowserSuggestionSettings;
    write(settings: BrowserSuggestionSettings): void;
  };
  readonly logSuggestion?: (event: { readonly event: "browser.suggest"; readonly timestamp: string; readonly transmitted: boolean; readonly reason: string; readonly count: number }) => void;
  readonly browserMcp: {
    pasteIntoTerminal(id: string): boolean;
    isSessionOwner?(id: string): boolean;
  };
  readonly objectiveRecords: { get(id: string): { id: string; commodoreId: string; [key: string]: unknown } | null };
  /** 자식 세션 → 브라우저의 주인(루트). 자식 세션은 자기 브라우저를 갖지 않고 루트의 것을 함께 쓴다. 없으면 자기 자신이다. */
  readonly browserOwnerOf?: (objectiveId: string) => string | null;
  /** Desktop 이 그린 크롬에서 만든 이미지(스크린샷·주석 결과)를 Console 화면의 입력창으로 넘긴다 — 이 라우트가 Console 이 받는 유일한 크롬 결과다. */
  readonly publishAttach?: (attach: { readonly kind: "screenshot" | "annotation"; readonly mime: "image/png"; readonly data: string }) => boolean;
  readonly isWriteAdmitted: (req: IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: IncomingMessage) => boolean;
  /** 이 요청의 창 표면. 원격·웹·비관리 Desktop 은 viewer. */
  readonly surfaceMode: (req: IncomingMessage) => BrowserSurfaceModeKind;
  /** 관리 창 또는 락 토큰을 가진 관리 Desktop 메인 프로세스만 사람 조작을 쓴다. */
  readonly isNativeBrowserWrite: (req: IncomingMessage) => boolean;
  /** 락 토큰으로 증명된 관리 Desktop 메인 프로세스. Origin 이 없는 브라우저 액션을 이 경우에만 허용한다. */
  readonly isManagingDesktopProcess: (req: IncomingMessage) => boolean;
  /** 보기 전용 프레임을 읽을 수 있는 세션인가. 아니면 401/403. */
  readonly viewerFrameRead: (req: IncomingMessage) => "ok" | "unauthorized" | "forbidden";
  readonly writeJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T | null>;
  readonly readUrl: (req: IncomingMessage) => URL;
  readonly withSecurityHeaders: (headers: OutgoingHttpHeaders) => OutgoingHttpHeaders;
}

const BROWSER_PASTE_MAX_BYTES = 48 * 1024 * 1024;

const VIEWER_FRAME_PATH = "/api/v1/browser/viewer/frame";
const VIEWER_UNWATCH_PATH = "/api/v1/browser/viewer/unwatch";
const DEFAULT_FRAME_WAIT_MS = 12_000;
const MAX_FRAME_WAIT_MS = 15_000;

export function createBrowserRouter(deps: BrowserRouteDeps): RouteHandler {
  const { browserService, desktopEngine, browserMcp, objectiveRecords, isWriteAdmitted, isExactConsoleOrigin, surfaceMode, isNativeBrowserWrite, isManagingDesktopProcess, viewerFrameRead, writeJson, readJsonBody, readUrl, withSecurityHeaders } = deps;
  const withSurface = <T extends object>(req: IncomingMessage, body: T) => ({ ...body, surfaceMode: surfaceMode(req) });
  const executionHost = (): BrowserExecutionHost => browserService.availability().executionHost;
  return async ({ req, res, pathname }) => {
    if (!isWriteAdmitted(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (pathname === VIEWER_FRAME_PATH || pathname === VIEWER_UNWATCH_PATH) return serveViewer(req, res, pathname);
    if (req.method === "GET" && pathname === "/api/v1/browser") { writeJson(res, 200, withSurface(req, browserService.status())); return true; }
    if (!pathname.startsWith("/api/v1/browser/objectives/") && !isNativeBrowserWrite(req)) { writeJson(res, 403, { error: "browser_viewer_read_only" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/browser/import-sources") {
      if (!browserService.available()) { writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() }); return true; }
      try { writeJson(res, 200, await browserService.importSources()); }
      catch (error) { writeJson(res, 500, { error: "browser_request_failed", message: error instanceof Error ? error.message : "browser_request_failed" }); }
      return true;
    }
    if (pathname === "/api/v1/browser/suggestion-settings") {
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "GET") {
        writeJson(res, 200, deps.suggestionSettings?.read() ?? DEFAULT_BROWSER_SUGGESTION_SETTINGS);
        return true;
      }
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req) && !isManagingDesktopProcess(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      const body = await readJsonBody<Record<string, unknown>>(req, 4096);
      if (!body || typeof body.enabled !== "boolean") { writeJson(res, 400, { error: "invalid_request" }); return true; }
      if (!deps.suggestionSettings) { writeJson(res, 503, { error: "settings_unavailable" }); return true; }
      // 켜기·끄기·안내 닫기 모두 사람의 명시적 선택이다. 프로필 등 다른 설정은 저장 포트가 보존한다.
      const settings = { enabled: body.enabled, prompted: true };
      deps.suggestionSettings.write(settings);
      writeJson(res, 200, settings);
      return true;
    }
    if (pathname === "/api/v1/browser/suggest") {
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req) && !isManagingDesktopProcess(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      res.setHeader("Cache-Control", "no-store");
      const finish = (transmitted: boolean, reason: string, suggestions: string[] = []) => {
        // 입력 원문·URL·예외 본문은 기록하지 않는다. 판정과 결과 개수만 남긴다.
        deps.logSuggestion?.({ event: "browser.suggest", timestamp: new Date().toISOString(), transmitted, reason, count: suggestions.length });
        writeJson(res, 200, { suggestions });
        return true;
      };
      if (!deps.suggestionSettings?.read().enabled) return finish(false, "disabled");
      if (!browserService.available()) return finish(false, "browser_unavailable");
      const body = await readJsonBody<Record<string, unknown>>(req, 4096);
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      const skip = suggestionSkipReason(query);
      if (skip) return finish(false, skip);
      // 본문을 기다리는 동안 설정이 바뀌었을 수 있다. 외부 호출 직전에 다시 확인한다.
      if (!deps.suggestionSettings.read().enabled) return finish(false, "disabled");
      try {
        const url = new URL("https://suggestqueries.google.com/complete/search");
        url.searchParams.set("client", "firefox");
        url.searchParams.set("q", query);
        const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "error" });
        if (!response.ok) return finish(true, "http_error");
        const text = await response.text();
        let data: unknown;
        try { data = JSON.parse(text); }
        catch { return finish(true, "invalid_response"); }
        if (!Array.isArray(data) || !Array.isArray(data[1]) || !data[1].every((item: unknown) => typeof item === "string")) return finish(true, "invalid_response");
        const suggestions = [...new Set<string>(data[1])].filter((item) => item.trim() && item.length <= 256).slice(0, 5);
        return finish(true, "ok", suggestions);
      } catch {
        // 제안 실패는 탐색 실패가 아니다. 예외에 포함될 수 있는 검색어도 로그에 남기지 않는다.
        return finish(true, "request_failed");
      }
    }
    if (pathname === "/api/v1/browser/default-profile") {
      // Console 전체의 설정이라 Objective 아래가 아니다. 엔진이 없어도 정할 수 있다 — 다음 Objective 을 위한 값이다.
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req) && !isManagingDesktopProcess(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body || (body.profile !== null && typeof body.profile !== "string")) { writeJson(res, 400, { error: "invalid_request" }); return true; }
      try { writeJson(res, 200, { defaultProfile: browserService.setDefaultProfile(body.profile) }); }
      catch (error) {
        if (error instanceof BrowserPolicyError) writeJson(res, 400, { error: error.code, message: error.message });
        else writeJson(res, 500, { error: "browser_request_failed" });
      }
      return true;
    }
    if (pathname === "/api/v1/browser/attach") {
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req) && !isManagingDesktopProcess(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      const body = await readJsonBody<Record<string, unknown>>(req, BROWSER_PASTE_MAX_BYTES);
      if (!body || (body.kind !== "screenshot" && body.kind !== "annotation") || body.mime !== "image/png" || typeof body.data !== "string" || body.data.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body.data)) { writeJson(res, 400, { error: "invalid_request" }); return true; }
      // 받을 Console 화면(Desktop 안의 렌더러)이 없으면 이미지는 갈 곳이 없다.
      if (!deps.publishAttach?.({ kind: body.kind, mime: "image/png", data: body.data })) { writeJson(res, 409, { error: "no_console_view" }); return true; }
      writeJson(res, 200, { delivered: true });
      return true;
    }
    if (pathname === "/api/v1/browser/shortcuts") {
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!isExactConsoleOrigin(req) && !isManagingDesktopProcess(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body || !Array.isArray(body.shortcuts) || !body.shortcuts.every((item) => typeof item === "string")) {
        writeJson(res, 400, { error: "invalid_request" }); return true;
      }
      browserService.setShortcuts(body.shortcuts);
      writeJson(res, 200, { ok: true, shortcuts: body.shortcuts });
      return true;
    }
    const match = /^\/api\/v1\/browser\/objectives\/([^/]+)\/(state|screenshot|tabs|navigate|viewport|inspect|paste|favicon|history|import|profile|clear-profile|surface|control)$/u.exec(pathname);
    if (!match) { writeJson(res, 404, { error: "not_found" }); return true; }
    const requestedId = decodeURIComponent(match[1] ?? "");
    const action = match[2] ?? "";
    // 전역 id 는 Objective 로 해석하지 않는다. 문맥별 별칭도 모두 같은 브라우저를 연다.
    const global = requestedId === GLOBAL_BROWSER_OWNER_ID;
    const requested = global ? null : objectiveRecords.get(requestedId);
    const rootId = requested ? deps.browserOwnerOf?.(requested.id) ?? requested.id : null;
    const objectiveRecord = rootId ? objectiveRecords.get(rootId) : null;
    const sessionOwner = !requested && !global && browserMcp.isSessionOwner?.(requestedId) === true;
    if (!global && !objectiveRecord && !sessionOwner) { writeJson(res, 404, { error: "objectiveRecord_not_found" }); return true; }
    const objectiveId = BROWSER_GLOBAL_ID;
    // 사람이 보고 있는 스페이스는 셸이 안다 — 표시 탭이 없을 때의 새 탭·뷰포트 요청에 실어 보낸다.
    const spaceId = (body: Record<string, unknown>): string | undefined => typeof body.spaceId === "string" && body.spaceId && body.spaceId.length <= 256 ? body.spaceId : undefined;
    // 상태는 쓸 수 없을 때도 답한다 — 패널이 왜 닫혀 있는지 그 답으로 듣는다.
    if (!isHumanRead(req.method ?? "GET", pathname, action) && !isNativeBrowserWrite(req)) { writeJson(res, 403, { error: "browser_viewer_read_only" }); return true; }
    if (action !== "state" && !browserService.available()) { writeJson(res, 409, { error: "browser_unavailable", ...browserService.availability() }); return true; }
    const fail = (error: unknown) => {
      if (error instanceof BrowserPolicyError) { writeJson(res, 400, { error: error.code, message: error.message, ...error.detail }); return; }
      const message = error instanceof Error ? error.message : "browser_request_failed";
      writeJson(res, 500, { error: message.startsWith("browser_") ? message : "browser_request_failed" });
    };
    if (req.method === "GET" && action === "state") {
      // 뒤따르는 변화는 Objective 스트림의 browser:state 로 간다 — 이 답은 그 스트림에 붙는 화면의 출발점이다.
      writeJson(res, 200, withSurface(req, browserService.state(objectiveId)));
      return true;
    }
    if (req.method === "GET" && action === "favicon") {
      const params = readUrl(req).searchParams;
      const historyId = params.get("historyId");
      const icon = await (historyId && /^[a-f0-9]{64}$/u.test(historyId)
        ? browserService.historyFavicon(objectiveId, historyId)
        : browserService.favicon(objectiveId, params.get("tabId") ?? "")).catch(() => null);
      if (!icon) { writeJson(res, 404, { error: "not_found" }); return true; }
      res.writeHead(200, { ...withSecurityHeaders({ "Content-Type": icon.type, "Cache-Control": "no-store", "Content-Length": String(icon.body.byteLength) }), "Content-Security-Policy": "default-src 'none'; sandbox" });
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
    if (!isExactConsoleOrigin(req) && !isManagingDesktopProcess(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
    const body = await readJsonBody<Record<string, unknown>>(req, action === "paste" ? BROWSER_PASTE_MAX_BYTES : undefined);
    if (!body) { writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      if (action === "history") {
        if (typeof body.query !== "string" || body.query.length > 2048) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        res.setHeader("Cache-Control", "no-store");
        writeJson(res, 200, { history: await browserService.historySuggestions(objectiveId, body.query) }); return true;
      }
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
        if (body.action === "create") { const space = spaceId(body); const tab = await browserService.createTab(objectiveId, typeof body.url === "string" ? body.url : null, "user", space ? { spaceId: space } : {}); writeJson(res, 200, { tab }); return true; }
        if (body.action === "close" && tabId) { await browserService.closeTab(objectiveId, tabId); writeJson(res, 200, { closed: tabId }); return true; }
        if (body.action === "select" && tabId) { await browserService.selectTab(objectiveId, tabId); writeJson(res, 200, { selected: tabId }); return true; }
        // 크롬 표시줄의 확인·취소 — 그 탭의 alert·confirm 에 답한다.
        if (body.action === "dialog" && tabId && typeof body.accept === "boolean" && typeof body.dialogId === "string") { await browserService.answerDialog(objectiveId, body.accept, body.dialogId, tabId); writeJson(res, 200, { answered: body.dialogId }); return true; }
        // 셸이 탭 없는 스페이스를 띄운다 — 표시 탭만 내리고 탭은 그대로 둔다.
        if (body.action === "deselect") { browserService.deselectTab(objectiveId); writeJson(res, 200, { selected: null }); return true; }
        writeJson(res, 400, { error: "invalid_request" }); return true;
      }
      if (action === "navigate") {
        if (typeof body.url !== "string") { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, await browserService.navigate(objectiveId, body.url, "user", typeof body.tabId === "string" ? body.tabId : null, undefined, spaceId(body))); return true;
      }
      if (action === "viewport") {
        const preset = body.preset === "responsive" || body.preset === "mobile" || body.preset === "tablet" ? body.preset : undefined;
        const colorScheme = body.colorScheme === "light" || body.colorScheme === "dark" ? body.colorScheme : body.colorScheme === null ? null : undefined;
        writeJson(res, 200, { viewport: await browserService.setViewport(objectiveId, { preset, width: typeof body.width === "number" ? body.width : undefined, height: typeof body.height === "number" ? body.height : undefined, colorScheme }, "user", spaceId(body)) }); return true;
      }
      if (action === "surface") {
        if ((body.action !== "open" && body.action !== "close" && body.action !== "focus" && body.action !== "mode")
          || (body.action !== "open" && typeof body.id !== "string") || (body.mode !== undefined && body.mode !== "pane" && body.mode !== "window") || (body.action === "mode" && body.mode === undefined)) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        browserService.surface(objectiveId, body.action, typeof body.id === "string" ? body.id : undefined, body.mode as "pane" | "window" | undefined);
        writeJson(res, 200, { surface: browserService.state(objectiveId).surface }); return true;
      }
      if (action === "control") {
        // 사람의 제어 동작 — 셸이 그린 알약의 가져오기·돌려주기·중지가 이 길로 온다.
        const space = spaceId(body);
        if (!space || (body.action !== "take" && body.action !== "return" && body.action !== "stop")) { writeJson(res, 400, { error: "invalid_request" }); return true; }
        writeJson(res, 200, { spaceId: space, control: browserService.setControl(objectiveId, space, body.action) }); return true;
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
        if (!browserMcp.pasteIntoTerminal(objectiveRecord.id)) { writeJson(res, 409, { error: "terminal_not_running" }); return true; }
        writeJson(res, 200, { pasted: true }); return true;
      }
      writeJson(res, 404, { error: "not_found" });
    } catch (error) { fail(error); }
    return true;

    async function serveViewer(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
      const admission = viewerFrameRead(req);
      if (admission !== "ok") { writeJson(res, admission === "unauthorized" ? 401 : 403, { error: admission === "unauthorized" ? "unauthorized" : "forbidden" }); return true; }
      const params = readUrl(req).searchParams;
      const tabId = params.get("tabId") ?? "";
      if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(tabId)) { writeJson(res, 400, { error: "invalid_request" }); return true; }
      if (req.method === "POST" && pathname === VIEWER_UNWATCH_PATH) {
        const viewId = browserService.viewIdOfTab(BROWSER_GLOBAL_ID, tabId);
        if (viewId) desktopEngine.clearWatch(viewId);
        res.writeHead(204, withSecurityHeaders({ "Cache-Control": "no-store" }));
        res.end();
        return true;
      }
      if (req.method !== "GET" || pathname !== VIEWER_FRAME_PATH) { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      const host = executionHost();
      if (host.status !== "connected") { writeJson(res, 409, { error: "browser_unavailable", executionHost: host }); return true; }
      const viewId = browserService.viewIdOfTab(BROWSER_GLOBAL_ID, tabId);
      if (!viewId) { writeJson(res, 404, { error: "tab_not_found" }); return true; }
      const afterSeq = Number(params.get("afterSeq") ?? "0");
      const requestedWait = params.has("waitMs") ? Number(params.get("waitMs")) : DEFAULT_FRAME_WAIT_MS;
      const waitMs = Number.isFinite(requestedWait) ? Math.min(MAX_FRAME_WAIT_MS, Math.max(0, requestedWait)) : DEFAULT_FRAME_WAIT_MS;
      const release = desktopEngine.acquireWatch(viewId);
      const abort = new AbortController();
      let settled = false;
      const finish = (lease: boolean) => { if (settled) return; settled = true; release(lease); };
      const onClose = () => { if (!res.writableEnded) { abort.abort(); finish(false); } };
      res.on("close", onClose);
      try {
        const frame = await desktopEngine.waitForFrame(viewId, Number.isFinite(afterSeq) ? afterSeq : 0, waitMs, abort.signal);
        if (res.writableEnded || res.destroyed) { finish(false); return true; }
        res.writeHead(200, withSecurityHeaders({
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store",
          "Content-Length": String(frame.bytes.length),
          [DESKTOP_BROWSER_FRAME_SEQ_HEADER]: String(frame.seq),
          [DESKTOP_BROWSER_FRAME_WIDTH_HEADER]: String(frame.width),
          [DESKTOP_BROWSER_FRAME_HEIGHT_HEADER]: String(frame.height),
          [DESKTOP_BROWSER_FRAME_AT_HEADER]: String(frame.at),
        }));
        res.end(frame.bytes);
        finish(true);
      } catch (error) {
        if (res.writableEnded || res.destroyed) { finish(false); return true; }
        if (error instanceof ViewerFrameTimeoutError || abort.signal.aborted) {
          if (abort.signal.aborted) { finish(false); return true; }
          res.writeHead(204, withSecurityHeaders({ "Cache-Control": "no-store" }));
          res.end();
          finish(true);
          return true;
        }
        if (error instanceof ViewerFrameClosedError) { writeJson(res, 404, { error: "tab_not_found" }); finish(false); return true; }
        if (error instanceof ViewerFrameDisconnectedError) { writeJson(res, 409, { error: "browser_unavailable", executionHost: executionHost() }); finish(false); return true; }
        writeJson(res, 500, { error: "browser_request_failed" });
        finish(false);
      } finally {
        res.off("close", onClose);
      }
      return true;
    }
  };
}

function isHumanRead(method: string, pathname: string, action: string | null): boolean {
  if (method === "GET" && (pathname === "/api/v1/browser" || pathname === VIEWER_FRAME_PATH)) return true;
  if (method === "POST" && pathname === VIEWER_UNWATCH_PATH) return true;
  return method === "GET" && (action === "state" || action === "favicon");
}
