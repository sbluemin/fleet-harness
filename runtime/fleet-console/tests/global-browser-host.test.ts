import { describe, expect, it } from "vitest";
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

describe("session browser host contract", () => {
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

  it("rejects the removed global browser route and keeps shortcut origin gates", async () => {
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

    const objectiveRecords = new Map<string, { id: string; payload: Record<string, unknown> }>();
    let exactOrigin = true;
    let writeAdmitted = true;

    const router = createBrowserRouter({
      browserService: service,
      browserMcp: { interruptObjective: () => 0, pasteIntoTerminal: () => false },
      objectiveRecords: { get: (id: string) => objectiveRecords.get(id) ?? null },
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

    // 옛 상태·복원으로 id "global"인 Objective이 들어와 있어도 Session 경로에 붙지 않는다.
    objectiveRecords.set("global", { id: "global", payload: {} });
    const spoofRes = {} as ServerResponse;
    await router({ req: { method: "GET" } as IncomingMessage, res: spoofRes, pathname: "/api/v1/browser/objectives/global/state" });
    expect((spoofRes as unknown as { status: number }).status).toBe(404);
    objectiveRecords.delete("global");

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

  it("keeps Session browsers isolated from the reserved global id", async () => {
    const attached = new Set<string>();
    const answered = new Set<number>();
    const urls = new Map<string, string>();
    // 실제 서비스·DesktopEngine 경로를 통과시키고, 셸의 부착·CDP 응답만 대신한다.
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
            result = { result: { type: "undefined" } };
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
    const browser = createBrowserMcpHost({ service, objectiveRecords: () => [], screenshots: { release: (id: string) => released.push(id), cleanup: () => {} } as never });
    try {
      await expect(service.createTab(GLOBAL_BROWSER_OWNER_ID, "https://example.com/reserved", "user")).rejects.toMatchObject({ code: "browser_owner_reserved" });
      expect(service.status().objectiveRecords).not.toContain(GLOBAL_BROWSER_OWNER_ID);
      const foreign = await service.createTab("op-foreign", "https://example.com/foreign", "user");

      // 에이전트의 동시 생성도 완성 탭과 생성 예약을 합쳐 Objective별 8개까지만 받는다.
      for (let index = 0; index < 7; index += 1) await service.createTab("op-target", null, "agent");
      const concurrent = await Promise.allSettled(Array.from({ length: 4 }, () => service.createTab("op-target", null, "agent")));
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual([
        "browser_tab_limit", "browser_tab_limit", "browser_tab_limit",
      ]);
      expect(service.state("op-target").tabs).toHaveLength(8);

      await service.closeObjective("op-target");
      expect(service.state("op-foreign").tabs.map((tab) => tab.id)).toEqual([foreign.id]);

      // 허용 회수가 첫 탭 생성과 겹쳐도 제거된 Objective에 옛 탭·네이티브 타깃이 되살아나지 않는다.
      const viewsBeforeReset = engine.snapshot().views.map((view) => view.id);
      const interrupted = service.createTab("op-reset", null, "agent");
      const interruptedResult = interrupted.catch((error: unknown) => error);
      const resettingOp = (service as unknown as { objectiveRecords: Map<string, { contextId: string; pendingTabs: number; tabs: Map<string, unknown> }> }).objectiveRecords.get("op-reset")!;
      await service.closeObjective("op-reset");
      expect(await interruptedResult).toMatchObject({ code: "browser_call_interrupted" });
      expect(resettingOp.tabs.size).toBe(0);
      expect(resettingOp.contextId).toBe("");
      expect(resettingOp.pendingTabs).toBe(0);
      expect(engine.snapshot().views.map((view) => view.id)).toEqual(viewsBeforeReset);
      expect(service.state("op-foreign").tabs.map((tab) => tab.id)).toEqual([foreign.id]);

      // 사령관은 실제 AgentHost가 실은 MCP로 자기 탭만 다룬다. 전역 탭 id를 알아도 넘어갈 수 없다.
      let client: Client | null = null;
      let browserTurn: (turn: ClaudeGatewayTurn) => Promise<void>;
      const agent = createPluginAgentHost({
        baseUrl: () => "http://127.0.0.1:1",
        consoleUse: { connect: () => { throw new Error("unexpected console access"); } },
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
        const session = await agent.createSession({ model: "sonnet", systemPrompt: "test", continuation: "conversation", settlement: "result", tools: { browser: { scopeId: "commodore:00000000-0000-0000-0000-000000000001" } } });
        const owner = browser.resolveSessionOwner("commodore", "commodore:00000000-0000-0000-0000-000000000001")!;
        expect(owner).toBeTruthy();
        expect(owner).not.toBe(GLOBAL_BROWSER_OWNER_ID);
        expect(browser.isSessionOwner(GLOBAL_BROWSER_OWNER_ID)).toBe(false);
        browserTurn = async (turn) => {
          expect(turn.allowedTools).toContain("mcp__fleet-browser__tabs_create");
          const server = turn.mcpServers!["fleet-browser"] as unknown as { instance: McpServer };
          const [caller, receiver] = InMemoryTransport.createLinkedPair();
          client = new Client({ name: "browser-contract", version: "1" });
          await server.instance.connect(receiver);
          await client.connect(caller);
          expect((await client.listTools()).tools.some((tool) => tool.name === "capture")).toBe(true);
          expect((await client.callTool({ name: "tabs_create", arguments: {} })).isError).not.toBe(true);
          expect(service.state(owner).tabs).toHaveLength(1);
          expect((await client.callTool({ name: "tabs_select", arguments: { tabId: foreign.id } })).isError).toBe(true);
          expect(service.state("op-foreign").tabs.map((tab) => tab.id)).toEqual([foreign.id]);
        };
        await session.send("open isolated tab");
        expect(service.state(owner).driving).toBe(false);
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
        expect(service.state(owner).tabs).toHaveLength(0);
        expect(released).toContain(owner);
        expect(service.state("op-foreign").tabs.map((tab) => tab.id)).toEqual([foreign.id]);
        const reconnected = browser.connectPlugin({ pluginId: "commodore", scopeId: "commodore:00000000-0000-0000-0000-000000000001", enabled: () => true });
        expect(browser.resolveSessionOwner("commodore", "commodore:00000000-0000-0000-0000-000000000001")).toBe(owner);
        const another = browser.connectPlugin({ pluginId: "another", scopeId: "commodore:00000000-0000-0000-0000-000000000001", enabled: () => true });
        expect(browser.resolveSessionOwner("another", "commodore:00000000-0000-0000-0000-000000000001")).not.toBe(owner);
        await reconnected.dispose(); await another.dispose();
      } finally { await agent.dispose(); await (client as Client | null)?.close(); }

      const router = createBrowserRouter({
        browserService: service,
        browserMcp: browser,
        objectiveRecords: { get: (id: string) => id === GLOBAL_BROWSER_OWNER_ID ? { id, payload: {} } : null },
        isWriteAdmitted: () => true,
        isExactConsoleOrigin: () => true,
        writeJson: (res, status, body) => { Object.assign(res, { status, body }); },
        readJsonBody: async <T>() => ({} as T),
        readUrl: () => new URL("http://localhost:50212/api/v1/browser/sessions/resolve?pluginId=commodore&scopeId=commodore%3A00000000-0000-0000-0000-000000000001"),
        withSecurityHeaders: (headers) => headers,
      });
      const resolved = {} as ServerResponse & { status: number; body: { ownerId: string } };
      await router({ req: { method: "GET" } as IncomingMessage, res: resolved, pathname: "/api/v1/browser/sessions/resolve" });
      expect(resolved.body.ownerId).toBe(browser.resolveSessionOwner("commodore", "commodore:00000000-0000-0000-0000-000000000001"));
      const sessionState = {} as ServerResponse & { status: number; body: { objectiveId: string } };
      await router({ req: { method: "GET" } as IncomingMessage, res: sessionState, pathname: `/api/v1/browser/objectives/${encodeURIComponent(resolved.body.ownerId)}/state` });
      expect(sessionState.status).toBe(200);
      expect(sessionState.body.objectiveId).toBe(resolved.body.ownerId);
      const removed = {} as ServerResponse & { status: number; body: { error: string } };
      await router({ req: { method: "GET" } as IncomingMessage, res: removed, pathname: "/api/v1/browser/global/state" });
      expect(removed.status).toBe(404);
      const spoof = {} as ServerResponse & { status: number };
      await router({ req: { method: "GET" } as IncomingMessage, res: spoof, pathname: "/api/v1/browser/objectives/global/state" });
      expect(spoof.status).toBe(404);
      expect(service.status().objectiveRecords).not.toContain(GLOBAL_BROWSER_OWNER_ID);

      const notices: { available: boolean }[] = [];
      service.onAvailability((notice) => notices.push(notice));
      service.reconcile();
      expect(notices.some((notice) => notice.available === true)).toBe(true);
    } finally {
      await browser.dispose();
    }
  });
});
