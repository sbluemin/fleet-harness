import { describe, expect, it, vi } from "vitest";
import { sanitizeConsoleSettingsData } from "../features/settings/host/settings-domain.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClaudeGatewaySdk, ClaudeGatewayTurn } from "@fleet-console/agent-runtime/claude";
import { createBrowserMcpHost } from "../features/browser/host/mcp.js";
import { createPluginAgentHost } from "../features/execution/host/agent/plugin-agent.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DesktopBrowserRelay, DesktopBrowserSnapshot } from "@fleet-console/protocol/desktop";

import { DesktopEngine } from "../features/browser/host/desktop-engine.js";
import { BrowserService, GLOBAL_BROWSER_OWNER_ID } from "../features/browser/host/service.js";
import { createBrowserRouter } from "../features/browser/host/routes.js";
import { BROWSER_GLOBAL_ID } from "../features/browser/shared/browser-id.js";
import { DESKTOP_BROWSER_DEFAULT_SPACE_ID, DESKTOP_BROWSER_TAB_LIMITS, commodoreBrowserSpaceId } from "@fleet-console/protocol/desktop";

describe("session browser host contract", () => {
  it("sends suggestions only after consent, never sends addresses, and degrades without leaking input", async () => {
    const engine = new DesktopEngine({ publish: () => {}, log: () => {} });
    engine.subscriberOpened("local");
    engine.setHost("local");
    const service = new BrowserService({ enabled: () => true, availability: () => ({ available: true, reason: null, host: "local" }), desktop: engine, log: () => {}, defaultProfile: { read: () => null, write: () => {} } });
    let stored = sanitizeConsoleSettingsData({ version: 1, browser: { defaultProfile: "default" } });
    let body: Record<string, unknown> = { query: "private search terms" };
    let exactOrigin = true;
    const logs: unknown[] = [];
    let result: unknown;
    let status = 0;
    const router = createBrowserRouter({
      browserService: service,
      browserMcp: { pasteIntoTerminal: () => false },
      objectiveRecords: { get: () => null },
      suggestionSettings: {
        read: () => ({ enabled: stored.browser?.suggestionsEnabled === true, prompted: stored.browser?.suggestionsPrompted === true }),
        write: (settings) => { stored = sanitizeConsoleSettingsData({ ...stored, browser: { ...stored.browser, suggestionsEnabled: settings.enabled, suggestionsPrompted: settings.prompted } }); },
      },
      logSuggestion: (event) => logs.push(event),
      isWriteAdmitted: () => true, isExactConsoleOrigin: () => exactOrigin,
      readJsonBody: async <T>() => body as T,
      writeJson: (_res, code, data) => { status = code; result = data; },
      readUrl: () => new URL("http://localhost"), withSecurityHeaders: (headers) => headers,
    });
    const request = (pathname = "/api/v1/browser/suggest") => router({ req: { method: "POST" } as IncomingMessage, res: { setHeader: () => {} } as unknown as ServerResponse, pathname });
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(["private search terms", ["first", "second", "third", "fourth", "fifth", "sixth"]])));
    try {
      await request();
      expect(upstream).not.toHaveBeenCalled();
      expect(result).toEqual({ suggestions: [] });
      expect(logs.at(-1)).toMatchObject({ transmitted: false, reason: "disabled" });
      body = { enabled: true };
      exactOrigin = false;
      await request("/api/v1/browser/suggestion-settings");
      expect(status).toBe(403);
      expect(stored.browser?.suggestionsEnabled).toBeUndefined();
      exactOrigin = true;
      await request("/api/v1/browser/suggestion-settings");
      expect(stored.browser).toEqual({ defaultProfile: "default", suggestionsEnabled: true, suggestionsPrompted: true });
      for (const query of ["https://private", "localhost", "127.0.0.1", "2130706433", "[::1]", "intranet:8080", "internal.example", "/private/file", "see private.example", "private。example"]) {
        body = { query };
        await request();
        expect(result).toEqual({ suggestions: [] });
        expect(logs.at(-1)).toMatchObject({ transmitted: false, reason: "address_like" });
      }
      expect(upstream).not.toHaveBeenCalled();
      body = { query: "private search terms" };
      await request();
      expect(upstream).toHaveBeenCalledTimes(1);
      const [url, options] = upstream.mock.calls[0]!;
      expect(new URL(String(url)).origin).toBe("https://suggestqueries.google.com");
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(result).toEqual({ suggestions: ["first", "second", "third", "fourth", "fifth"] });
      upstream.mockResolvedValueOnce(new Response(JSON.stringify(["query", { malformed: true }])));
      await request();
      expect(result).toEqual({ suggestions: [] });
      expect(logs.at(-1)).toMatchObject({ transmitted: true, reason: "invalid_response" });
      upstream.mockRejectedValueOnce(new Error("private search terms"));
      await request();
      expect(result).toEqual({ suggestions: [] });
      expect(logs.at(-1)).toMatchObject({ transmitted: true, reason: "request_failed" });
      body = { enabled: false };
      await request("/api/v1/browser/suggestion-settings");
      upstream.mockClear();
      body = { query: "private search terms" };
      await request();
      expect(upstream).not.toHaveBeenCalled();
      expect(JSON.stringify(logs)).not.toContain("private");
    } finally { upstream.mockRestore(); }
  });
  it("hands a Desktop-drawn chrome image to the Console screen only from the exact origin and only when a view can receive it", async () => {
    const engine = new DesktopEngine({ publish: () => {}, log: () => {} });
    const service = new BrowserService({ enabled: () => true, availability: () => ({ available: true, reason: null, host: "local" }), desktop: engine, log: () => {}, defaultProfile: { read: () => null, write: () => {} } });
    let body: Record<string, unknown> = { kind: "annotation", mime: "image/png", data: "aWNvbg==" };
    let exactOrigin = true;
    let receiver = true;
    const delivered: unknown[] = [];
    let status = 0;
    const router = createBrowserRouter({
      browserService: service, browserMcp: { pasteIntoTerminal: () => false }, objectiveRecords: { get: () => null },
      publishAttach: (attach) => { if (receiver) delivered.push(attach); return receiver; },
      isWriteAdmitted: () => true, isExactConsoleOrigin: () => exactOrigin,
      readJsonBody: async <T>() => body as T,
      writeJson: (_res, code) => { status = code; },
      readUrl: () => new URL("http://localhost"), withSecurityHeaders: (headers) => headers,
    });
    const request = () => router({ req: { method: "POST" } as IncomingMessage, res: { setHeader: () => {} } as unknown as ServerResponse, pathname: "/api/v1/browser/attach" });
    exactOrigin = false; await request(); expect(status).toBe(403);
    exactOrigin = true; body = { kind: "annotation", mime: "image/png", data: "not base64!" }; await request(); expect(status).toBe(400);
    body = { kind: "annotation", mime: "image/png", data: "aWNvbg==" }; receiver = false; await request(); expect(status).toBe(409);
    receiver = true; await request(); expect(status).toBe(200);
    expect(delivered).toEqual([{ kind: "annotation", mime: "image/png", data: "aWNvbg==" }]);
  });
  it("includes shortcuts (including empty list) and generalizes viewOwner without fake objectives", async () => {
    const published: DesktopBrowserSnapshot[] = [];
    const engine = new DesktopEngine({ publish: (s) => published.push(s), log: () => {} });
    engine.subscriberOpened("local");
    engine.setHost("local");

    // 초기 상태(setShortcuts 미호출)는 shortcuts 필드 없음 (옛 Console 호환)
    expect(published.at(-1)?.shortcuts).toBeUndefined();

    engine.setShortcuts(["Mod+Shift+KeyB", "Mod+KeyK"]);
    expect(published.at(-1)?.shortcuts).toEqual(["Mod+Shift+KeyB", "Mod+KeyK"]);

    // 단축키를 모두 비웠을 때도 빈 배열이 전달되어 셸이 옛 목록을 지우도록 보장
    engine.setShortcuts([]);
    expect(published.at(-1)?.shortcuts).toEqual([]);

    // 뷰 생성 후 viewOwner 는 전역 소유자("global")도 정상 식별하여 자기 Console 탭을 shared 로 닫지 않게 한다.
    const context = await engine.send<{ browserContextId: string }>("Target.createBrowserContext", {});
    const creating = engine.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
    const pendingView = published.at(-1)?.views[0];
    expect(pendingView).toBeDefined();
    engine.relay("local", { attached: [pendingView!.id] });
    const { targetId } = await creating;

    engine.bindView(targetId, GLOBAL_BROWSER_OWNER_ID);
    expect(engine.viewOwner(targetId)).toBe("global");
    expect(engine.viewObjective(targetId)).toBe("global");
  });

  it("resolves every caller alias to the same global frame and keeps shortcut origin gates", async () => {
    const published: DesktopBrowserSnapshot[] = [];
    const engine = new DesktopEngine({ publish: (s) => published.push(s), log: () => {} });
    let defaultProfileValue: string | null = null;
    const service = new BrowserService({
      enabled: () => true,
      availability: () => ({ available: true, reason: null, host: "local" }),
      desktop: engine,
      log: () => {},
      defaultProfile: {
        read: () => defaultProfileValue,
        write: (p) => { defaultProfileValue = p; },
      },
    });

    const objectiveRecords = new Map<string, { id: string; commodoreId: string; payload: Record<string, unknown> }>();
    let exactOrigin = true;
    let writeAdmitted = true;

    const router = createBrowserRouter({
      browserService: service,
      browserMcp: { pasteIntoTerminal: () => false, isSessionOwner: (id) => id === "commodore:c" || id === "plugin-browser:s" },
      objectiveRecords: { get: (id: string) => objectiveRecords.get(id) ?? null },
      browserOwnerOf: (id) => id === "child" ? "root" : id,
      isWriteAdmitted: () => writeAdmitted,
      isExactConsoleOrigin: () => exactOrigin,
      writeJson: (res: ServerResponse, status: number, body: unknown) => {
        (res as unknown as { status: number; body: unknown }).status = status;
        (res as unknown as { status: number; body: unknown }).body = body;
      },
      readJsonBody: async <T>() => ({ shortcuts: ["Mod+Shift+KeyB"] }) as T,
      readUrl: (req: IncomingMessage) => new URL((req as unknown as { url: string }).url, "http://localhost:50212"),
      withSecurityHeaders: (h) => h,
    });

    // 삭제된 전역 경로는 Objective 으로 열리지 않는다.
    const stateRes = {} as ServerResponse;
    const handledState = await router({
      req: { method: "GET" } as IncomingMessage,
      res: stateRes,
      pathname: "/api/v1/browser/global/state",
    });
    expect(handledState).toBe(true);
    expect((stateRes as unknown as { status: number }).status).toBe(404);

    // 전역 경로와 문맥별 별칭은 모두 같은 상태를 준다. 어느 스페이스를 띄울지는 셸의 일이라 응답에 실리지 않는다.
    objectiveRecords.set("root", { id: "root", commodoreId: "c", payload: {} });
    objectiveRecords.set("child", { id: "child", commodoreId: "c", payload: {} });
    for (const id of [BROWSER_GLOBAL_ID, "root", "child", "commodore:c", "plugin-browser:s"]) {
      const state = {} as ServerResponse & { status: number; body: Record<string, unknown> };
      await router({ req: { method: "GET" } as IncomingMessage, res: state, pathname: `/api/v1/browser/objectives/${encodeURIComponent(id)}/state` });
      expect(state.status).toBe(200);
      expect(state.body).toEqual(service.state(BROWSER_GLOBAL_ID));
      expect(state.body.spaces).toMatchObject([{ id: DESKTOP_BROWSER_DEFAULT_SPACE_ID, kind: "default" }]);
    }
    writeAdmitted = false;
    const denied = {} as ServerResponse & { status: number };
    await router({ req: { method: "GET" } as IncomingMessage, res: denied, pathname: "/api/v1/browser/objectives/global/state" });
    expect(denied.status).toBe(404);
    writeAdmitted = true;

    // 2. POST /api/v1/browser/shortcuts — 단축키 설정
    const shortcutsRes = {} as ServerResponse;
    const handledShortcuts = await router({
      req: { method: "POST" } as IncomingMessage,
      res: shortcutsRes,
      pathname: "/api/v1/browser/shortcuts",
    });
    expect(handledShortcuts).toBe(true);
    expect((shortcutsRes as unknown as { status: number }).status).toBe(200);
    expect(published.at(-1)?.shortcuts).toEqual(["Mod+Shift+KeyB"]);

    // 3. Origin 게이트 검증: 비인가 Origin 요청 시 403 거부
    exactOrigin = false;
    const forbiddenRes = {} as ServerResponse;
    await router({
      req: { method: "POST" } as IncomingMessage,
      res: forbiddenRes,
      pathname: "/api/v1/browser/shortcuts",
    });
    expect((forbiddenRes as unknown as { status: number }).status).toBe(403);
  });

  it("shares one profile across spaces while preserving agent isolation and scoped teardown", async () => {
    const attached = new Set<string>();
    const answered = new Set<number>();
    const urls = new Map<string, string>();
    // 실제 서비스·DesktopEngine 경로를 통과시키고, 셸의 부착·CDP 응답만 대신한다.
    let historySnapshot: string | null = null;
    const historyWrites: string[] = [];
    let conflictNextHistoryWrite = false;
    const engine = new DesktopEngine({
      publish: (snapshot) => queueMicrotask(() => {
        const attaching = snapshot.views.filter((view) => !attached.has(view.id));
        for (const view of attaching) { attached.add(view.id); urls.set(view.id, view.url); }
        const commands = snapshot.commands.filter((command) => !answered.has(command.id));
        const events: NonNullable<DesktopBrowserRelay["events"]>[number][] = [];
        const results = commands.map((command) => {
          answered.add(command.id);
          let result: Record<string, unknown> = {};
          if (command.method === "Page.navigate") {
            urls.set(command.viewId, String(command.params.url));
            events.push({ viewId: command.viewId, method: "Page.loadEventFired", params: {} });
          } else if (command.method === "Page.getNavigationHistory") {
            result = { currentIndex: 0, entries: [{ url: urls.get(command.viewId) ?? "about:blank", title: "" }] };
          } else if (command.method === "Runtime.evaluate") {
            result = { result: { value: urls.get(command.viewId)?.includes("unrecorded") ? "https://example.com/large-icon.avif" : undefined } };
          } else if (command.method === "Fleet.browserHistory") {
            if (command.params.action === "write" && conflictNextHistoryWrite) {
              conflictNextHistoryWrite = false;
              const newer = JSON.parse(historySnapshot!);
              newer.entries.push({ url: "https://newer.example/retained", title: "Newer revision", visits: 1, lastVisited: Date.now(), iconUrl: null });
              historySnapshot = JSON.stringify(newer);
              return { id: command.id, error: "browser_history_changed" };
            }
            if (command.params.action === "write") { historySnapshot = String(command.params.data); historyWrites.push(String(command.params.browserProfile)); }
            result = { data: historySnapshot, revision: "fixture" };
          } else if (command.method === "Fleet.chromeHistory") {
            result = { entries: [{ url: "https://imported.example/docs", title: "가져온 문서", visits: 5, lastVisited: Date.now() }] };
          } else if (command.method === "Fleet.importChromeCookies") {
            return { id: command.id, error: "chrome_cookies_locked" };
          } else if (command.method === "Fleet.clearBrowserProfile") {
            historySnapshot = null;
          }
          return { id: command.id, result };
        });
        if (attaching.length || results.length) engine.relay("local", { attached: attaching.map((view) => view.id), results, events });
      }),
      log: () => {},
    });
    engine.subscriberOpened("local");
    engine.setHost("local");
    let shared = false;
    const service = new BrowserService({
      enabled: () => true,
      availability: () => shared ? ({ available: false, reason: "shared", host: null }) : ({ available: true, reason: null, host: "local" }),
      desktop: engine,
      log: () => {},
      defaultProfile: { read: () => "default", write: () => {} },
    });

    const released: string[] = [];
    const browser = createBrowserMcpHost({ service, objectiveRecords: () => [], commodoreExists: () => true, screenshots: { release: (id: string) => released.push(id), cleanup: () => {} } as never });
    try {
      await expect(service.createTab("commodore:old", null, "user")).rejects.toMatchObject({ code: "browser_id_invalid" });
      let foreign = await service.createTab(BROWSER_GLOBAL_ID, "https://example.com/foreign", "user");
      expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "example.com/foreign")).toMatchObject([{ url: "https://example.com/foreign" }]);
      // 쿠키 키체인이 막혀도 이력은 독립적으로 저장되고, 로컬 제안 조회는 외부 Suggest에 보내지 않는다.
      expect(await service.importFromChrome(BROWSER_GLOBAL_ID, "Default")).toMatchObject({ history: 1, cookies: 0, cookiesFailed: true, historyFailed: false });
      const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fixture-icon", { headers: { "Content-Type": "image/png" } }));
      try {
        const entries = await service.historySuggestions(BROWSER_GLOBAL_ID, "가져온");
        expect(entries).toMatchObject([{ url: "https://imported.example/docs", title: "가져온 문서" }]);
        expect(fetcher).not.toHaveBeenCalled();
        expect(await service.historyFavicon(BROWSER_GLOBAL_ID, entries[0]!.id)).toMatchObject({ type: "image/png" });
        expect(historySnapshot).toContain(Buffer.from("fixture-icon").toString("base64"));
        // 같은 영속 프로필은 새 서비스에서도 디스크 adapter를 통해 살아난다.
        const restarted = new BrowserService({ enabled: () => true, availability: () => ({ available: true, reason: null, host: "local" }), desktop: engine, log: () => {}, defaultProfile: { read: () => "default", write: () => {} } });
        expect(await restarted.historySuggestions(BROWSER_GLOBAL_ID, "가져온")).toEqual(entries);
        expect(await restarted.historyFavicon(BROWSER_GLOBAL_ID, entries[0]!.id)).toMatchObject({ type: "image/png" });
        expect(fetcher).toHaveBeenCalledTimes(1);
        conflictNextHistoryWrite = true;
        await service.createTab(BROWSER_GLOBAL_ID, "https://new-write.example/", "user");
        expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "newer.example")).toMatchObject([{ title: "Newer revision" }]);
        // 저장 대상이 아닌 URL의 큰 탭 아이콘도 표시한다. snapshot에는 넣지 않는다.
        const largeIcon = new Uint8Array(64 * 1024).fill(42);
        fetcher.mockResolvedValueOnce(new Response(largeIcon, { headers: { "Content-Type": "image/avif" } }));
        const unrecorded = await service.createTab(BROWSER_GLOBAL_ID, "https://user:password@example.com/unrecorded", "user");
        expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "unrecorded")).toEqual([]);
        expect(await service.favicon(BROWSER_GLOBAL_ID, unrecorded.id)).toEqual({ body: Buffer.from(largeIcon), type: "image/avif" });
        expect(historySnapshot).not.toContain(Buffer.from(largeIcon).toString("base64"));
        await service.setProfile(BROWSER_GLOBAL_ID, null);
        const writesBefore = historyWrites.length;
        await service.importFromChrome(BROWSER_GLOBAL_ID, "Default");
        expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "가져온")).toHaveLength(1);
        // 임시 프로필도 전역이다. 다른 스페이스가 열려 있어도 같은 이력을 읽는다.
        const temporary = await service.createTab(BROWSER_GLOBAL_ID, null, "user", { spaceId: commodoreBrowserSpaceId("temporary") });
        expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "가져온")).toHaveLength(1);
        expect(historyWrites).toHaveLength(writesBefore);
        await service.closeTab(BROWSER_GLOBAL_ID, temporary.id);
        const privateTab = await service.createTab(BROWSER_GLOBAL_ID, null, "user");
        await service.closeTab(BROWSER_GLOBAL_ID, privateTab.id);
        expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "가져온")).toEqual([]);
        await service.importFromChrome(BROWSER_GLOBAL_ID, "Default");
        await service.setProfile(BROWSER_GLOBAL_ID, "default");
        await service.setProfile(BROWSER_GLOBAL_ID, null);
        expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "가져온")).toEqual([]);
        await service.clearProfile("default");
        expect(historySnapshot).toBeNull();
        expect(await service.historySuggestions(BROWSER_GLOBAL_ID, "가져온")).toEqual([]);
        expect(await service.historyFavicon(BROWSER_GLOBAL_ID, entries[0]!.id)).toBeNull();
      } finally { fetcher.mockRestore(); }

      // 전체 리셋과 첫 생성이 겹쳐도 옛 네이티브 타깃이 되살아나지 않는다.
      const viewsBeforeReset = engine.snapshot().views.map((view) => view.id);
      const interrupted = service.createTab(BROWSER_GLOBAL_ID, null, "agent").catch((error: unknown) => error);
      await service.closeObjective(BROWSER_GLOBAL_ID);
      expect(await interrupted).toMatchObject({ code: "browser_call_interrupted" });
      expect(engine.snapshot().views.map((view) => view.id)).toEqual(viewsBeforeReset);

      // 서로 다른 스페이스의 첫 탭도 같은 임시 파티션에 선다. 한 사령관 스페이스를 함께 쓰는 두 Objective 중 하나를 거둬도 다른 탭은 남는다.
      await service.setProfile(BROWSER_GLOBAL_ID, null);
      const team = commodoreBrowserSpaceId("team");
      const callers = [
        { participantId: "objective-a", spaceId: team, ownerId: "objective-a" },
        { participantId: "objective-b", spaceId: team, ownerId: "objective-b" },
        { participantId: "other", spaceId: commodoreBrowserSpaceId("other"), ownerId: commodoreBrowserSpaceId("other") },
      ];
      const sharedTabs = await Promise.all(callers.map((caller) => service.createTab(BROWSER_GLOBAL_ID, null, "agent", { caller })));
      expect(sharedTabs.map((tab) => tab.spaceId)).toEqual([team, team, commodoreBrowserSpaceId("other")]);
      expect(new Set(engine.snapshot().views.map((view) => view.partition)).size).toBe(1);
      expect(engine.snapshot().views.every((view) => view.profile === null && view.objectiveId === BROWSER_GLOBAL_ID)).toBe(true);
      await service.closeOwner("objective-a");
      expect(service.state(BROWSER_GLOBAL_ID).tabs.map((tab) => tab.id)).toEqual(sharedTabs.slice(1).map((tab) => tab.id));
      foreign = sharedTabs[2]!;
      // 없는 스페이스에는 열 수 없다 — 스페이스는 디폴트와 사령관의 것뿐이다.
      await expect(service.createTab(BROWSER_GLOBAL_ID, null, "user", { spaceId: "objective-a" })).rejects.toMatchObject({ code: "browser_space_not_found" });

      // 생성 예약까지 세어 디폴트 8개·사령관 스페이스 16개·Console 전체 32개를 함께 지킨다.
      for (let index = 0; index < DESKTOP_BROWSER_TAB_LIMITS.default - 1; index += 1) await service.createTab(BROWSER_GLOBAL_ID, null, "user");
      const concurrent = await Promise.allSettled(Array.from({ length: 4 }, () => service.createTab(BROWSER_GLOBAL_ID, null, "user")));
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual([
        "browser_tab_limit", "browser_tab_limit", "browser_tab_limit",
      ]);
      const limited = { participantId: "limited", spaceId: commodoreBrowserSpaceId("limited"), ownerId: commodoreBrowserSpaceId("limited") };
      for (let index = 0; index < DESKTOP_BROWSER_TAB_LIMITS.commodore; index += 1) await service.createTab(BROWSER_GLOBAL_ID, null, "agent", { caller: limited });
      await expect(service.createTab(BROWSER_GLOBAL_ID, null, "agent", { caller: limited })).rejects.toMatchObject({ code: "browser_tab_limit", detail: { limit: DESKTOP_BROWSER_TAB_LIMITS.commodore } });
      const fill = await Promise.allSettled(Array.from({ length: DESKTOP_BROWSER_TAB_LIMITS.total }, (_, index) => service.createTab(BROWSER_GLOBAL_ID, null, "user", { spaceId: commodoreBrowserSpaceId(`fill-${index}`) })));
      expect(service.state(BROWSER_GLOBAL_ID).tabs).toHaveLength(DESKTOP_BROWSER_TAB_LIMITS.total);
      expect(fill.filter((result) => result.status === "rejected").every((result) => result.reason.code === "browser_tab_limit")).toBe(true);
      for (const spaceId of service.state(BROWSER_GLOBAL_ID).spaces.map((space) => space.id)) if (spaceId !== commodoreBrowserSpaceId("other")) await service.closeSpace(spaceId);

      // 묶음 회수와 생성이 겹쳐도 그 묶음의 탭은 되살아나지 않고 공유 브라우저와 다른 스페이스는 남는다.
      const closing = service.createTab(BROWSER_GLOBAL_ID, null, "agent", { caller: { participantId: "p", spaceId: team, ownerId: "obj-closed" } }).catch((error: unknown) => error);
      await service.closeOwner("obj-closed");
      expect(await closing).toMatchObject({ code: "browser_call_interrupted" });
      expect(service.state(BROWSER_GLOBAL_ID).tabs.map((tab) => tab.id)).toEqual([foreign.id]);

      // 사령관은 실제 AgentHost가 실은 MCP로 자기 스페이스만 조작한다. 다른 사령관과 디폴트 스페이스는 읽기만 한다.
      let client: Client | null = null;
      let ownId = "";
      let browserTurn: (turn: ClaudeGatewayTurn) => Promise<void>;
      const scopeId = commodoreBrowserSpaceId("00000000-0000-0000-0000-000000000001");
      const agent = createPluginAgentHost({
        baseUrl: () => "http://127.0.0.1:1",
        browserMcp: { connectPlugin: (options) => browser.connectPlugin({ ...options, pluginId: "commodore" }) },
        createSdk: async () => ({
          startTurn: async (turn: ClaudeGatewayTurn) => {
            await browserTurn(turn);
            return { close() {}, getContextUsage: async () => null, async *[Symbol.asyncIterator]() { yield { type: "result", is_error: false }; } };
          },
          dispose: async () => {},
        }) as unknown as ClaudeGatewaySdk,
      });
      try {
        const session = await agent.createSession({ model: "sonnet", systemPrompt: "test", continuation: "conversation", settlement: "result", tools: { browser: { scopeId } } });
        expect(browser.isSessionOwner(scopeId)).toBe(true);
        expect(browser.isSessionOwner(BROWSER_GLOBAL_ID)).toBe(false);
        browserTurn = async (turn) => {
          expect(turn.allowedTools).toContain("mcp__fleet-browser__tabs_create");
          const server = turn.mcpServers!["fleet-browser"] as unknown as { instance: McpServer };
          const [caller, receiver] = InMemoryTransport.createLinkedPair();
          client = new Client({ name: "browser-contract", version: "1" });
          await server.instance.connect(receiver);
          await client.connect(caller);
          expect((await client.listTools()).tools.some((tool) => tool.name === "capture")).toBe(true);
          expect((await client.callTool({ name: "tabs_create", arguments: {} })).isError).not.toBe(true);
          const own = service.state(BROWSER_GLOBAL_ID).tabs.find((tab) => tab.spaceId === scopeId)!;
          ownId = own.id;
          const objectiveTab = await service.createTab(BROWSER_GLOBAL_ID, "https://example.com/objective", "user");
          expect(service.state(BROWSER_GLOBAL_ID).activeTabId).toBe(objectiveTab.id);
          // 이 사령관의 Objective 가 같은 스페이스에 연 탭은 팀의 것이다 — 사령관이 작업 탭으로 삼을 수 있다.
          const teammate = await service.createTab(BROWSER_GLOBAL_ID, null, "agent", { caller: { participantId: "member", spaceId: scopeId, ownerId: "objective-x" } });
          expect((await client.callTool({ name: "tabs_select", arguments: { tabId: teammate.id } })).isError).not.toBe(true);
          expect((await client.callTool({ name: "tabs_select", arguments: { tabId: own.id } })).isError).not.toBe(true);
          const context = JSON.parse(String(((await client.callTool({ name: "tabs_context", arguments: { all: true } })).content as { text: string }[])[0]!.text)) as { currentTabId: string; tabs: { tabId: string }[]; spaces: { id: string }[] };
          expect(context.currentTabId).toBe(own.id);
          expect(context.tabs.map((tab) => tab.tabId)).toEqual([own.id, teammate.id]);
          expect(context.spaces.map((space) => space.id).sort()).toEqual([scopeId, commodoreBrowserSpaceId("other"), DESKTOP_BROWSER_DEFAULT_SPACE_ID].sort());
          expect((await client.callTool({ name: "read_console_messages", arguments: { tabId: foreign.id } })).isError).not.toBe(true);
          expect((await client.callTool({ name: "read_console_messages", arguments: { tabId: objectiveTab.id } })).isError).not.toBe(true);
          for (const tabId of [foreign.id, objectiveTab.id]) {
            for (const [name, args] of [
              ["navigate", { url: "https://example.com/hijack", tabId }],
              ["javascript_tool", { code: "document.title", tabId }],
            ] as const) {
              const write = await client.callTool({ name, arguments: args });
              expect(write.isError).toBe(true);
              expect(JSON.stringify(write.content)).toContain("browser_space_read_only");
            }
            const close = await client.callTool({ name: "tabs_close", arguments: { tabId } });
            expect(JSON.stringify(close.content)).toContain("browser_space_foreign");
            expect((await client.callTool({ name: "tabs_select", arguments: { tabId } })).isError).toBe(true);
          }
          const otherCaller = { participantId: "other", spaceId: foreign.spaceId, ownerId: foreign.spaceId };
          const foreignViewport = service.agentTabs(BROWSER_GLOBAL_ID, otherCaller, false).viewport;
          expect((await client.callTool({ name: "resize_window", arguments: { width: 640, height: 480 } })).isError).not.toBe(true);
          expect(service.agentTabs(BROWSER_GLOBAL_ID, otherCaller, false).viewport).toEqual(foreignViewport);
          expect(service.agentTabs(BROWSER_GLOBAL_ID, { participantId: "own", spaceId: scopeId, ownerId: scopeId }, false).viewport).toMatchObject({ width: 640, height: 480 });
          // Objective 를 거두면 그 Objective 가 연 탭만 닫힌다 — 같은 스페이스의 사령관 탭은 남는다.
          await service.closeOwner("objective-x");
          await service.closeTab(BROWSER_GLOBAL_ID, objectiveTab.id);
          expect(service.state(BROWSER_GLOBAL_ID).tabs.map((tab) => tab.id)).toEqual([foreign.id, own.id]);
        };
        await session.send("open shared browser tab");
        expect(service.state(BROWSER_GLOBAL_ID).driving).toBe(false);
        expect((await client!.callTool({ name: "tabs_create", arguments: {} })).isError).toBe(true);
        shared = true;
        browserTurn = async () => {
          const denied = await client!.callTool({ name: "tabs_create", arguments: {} });
          expect(denied.isError).toBe(true);
          expect(JSON.stringify(denied.content)).toContain("shared");
        };
        await session.send("browser paused");
        shared = false;
        await session.dispose();
        expect((await client!.callTool({ name: "tabs_context", arguments: {} })).isError).toBe(true);
        expect(service.state(BROWSER_GLOBAL_ID).tabs.map((tab) => tab.id)).toEqual([foreign.id, ownId]);
        expect(released).not.toContain(BROWSER_GLOBAL_ID);
        const reconnected = browser.connectPlugin({ pluginId: "commodore", scopeId, enabled: () => true });
        // 사령관에 묶이지 않은 세션은 디폴트 스페이스에 자기 묶음으로 선다. 사람이 거기서 연 탭은 그 세션에게 읽기 전용이고, 세션이 끝나면 자기가 연 탭만 닫힌다.
        const another = browser.connectPlugin({ pluginId: "another", scopeId, enabled: () => true });
        const [plainCaller, plainReceiver] = InMemoryTransport.createLinkedPair();
        const plain = new Client({ name: "plain-session", version: "1" });
        await (another.embeddedServer as unknown as { instance: McpServer }).instance.connect(plainReceiver);
        await plain.connect(plainCaller);
        try {
          expect((await plain.callTool({ name: "tabs_create", arguments: {} })).isError).not.toBe(true);
          const sessionTab = service.state(BROWSER_GLOBAL_ID).tabs.find((tab) => tab.spaceId === DESKTOP_BROWSER_DEFAULT_SPACE_ID)!;
          const humanTab = await service.createTab(BROWSER_GLOBAL_ID, null, "user");
          expect(humanTab.spaceId).toBe(DESKTOP_BROWSER_DEFAULT_SPACE_ID);
          expect(JSON.stringify((await plain.callTool({ name: "tabs_close", arguments: { tabId: humanTab.id } })).content)).toContain("browser_space_foreign");
          expect(JSON.stringify((await plain.callTool({ name: "javascript_tool", arguments: { code: "document.title", tabId: humanTab.id } })).content)).toContain("browser_space_read_only");
          await reconnected.dispose(); await another.dispose();
          expect(service.state(BROWSER_GLOBAL_ID).tabs.some((tab) => tab.id === sessionTab.id)).toBe(false);
          expect(service.state(BROWSER_GLOBAL_ID).tabs.map((tab) => tab.id)).toEqual([foreign.id, ownId, humanTab.id]);
          // 표시 탭을 내려도 탭은 남는다 — 셸이 탭 없는 스페이스를 띄울 때의 길이다.
          service.deselectTab(BROWSER_GLOBAL_ID);
          expect(service.state(BROWSER_GLOBAL_ID)).toMatchObject({ activeTabId: null });
          await service.closeTab(BROWSER_GLOBAL_ID, humanTab.id);
        } finally { await plain.close(); }
        expect(service.state(BROWSER_GLOBAL_ID).tabs.map((tab) => tab.id)).toEqual([foreign.id, ownId]);
      } finally { await agent.dispose(); await (client as Client | null)?.close(); }

      const router = createBrowserRouter({
        browserService: service, browserMcp: browser, objectiveRecords: { get: () => null },
        isWriteAdmitted: () => true, isExactConsoleOrigin: () => true,
        writeJson: (res, status, body) => { Object.assign(res, { status, body }); },
        readJsonBody: async <T>() => ({} as T),
        readUrl: () => new URL("http://localhost:50212/"),
        withSecurityHeaders: (headers) => headers,
      });
      const sessionState = {} as ServerResponse & { status: number; body: { objectiveId: string } };
      await router({ req: { method: "GET" } as IncomingMessage, res: sessionState, pathname: `/api/v1/browser/objectives/${encodeURIComponent(scopeId)}/state` });
      expect(sessionState.status).toBe(200);
      expect(sessionState.body).toMatchObject({ objectiveId: BROWSER_GLOBAL_ID });
      expect(service.status().objectiveRecords).toEqual([BROWSER_GLOBAL_ID]);

      const notices: { available: boolean }[] = [];
      service.onAvailability((notice) => notices.push(notice));
      service.reconcile();
      expect(notices.some((notice) => notice.available === true)).toBe(true);
    } finally {
      await browser.dispose();
    }
  });
});
