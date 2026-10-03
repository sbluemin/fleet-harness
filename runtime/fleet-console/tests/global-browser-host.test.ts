import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DesktopBrowserSnapshot } from "@fleet-console/protocol/desktop";

import { DesktopEngine } from "../features/browser/host/desktop-engine.js";
import { BrowserService, GLOBAL_BROWSER_OWNER_ID } from "../features/browser/host/service.js";
import { createBrowserRouter } from "../features/browser/host/routes.js";

describe("global fleet browser host contract", () => {
  it("includes shortcuts (including empty list) and generalizes viewOwner without fake operations", async () => {
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
    expect(engine.viewOperation(targetId)).toBe("global");
  });

  it("handles /api/v1/browser/global/* and shortcuts with strict origin gates and no fake operations", async () => {
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

    const operations = new Map<string, { id: string; payload: Record<string, unknown> }>();
    let exactOrigin = true;
    let writeAdmitted = true;

    const router = createBrowserRouter({
      browserService: service,
      browserMcp: { interruptOperation: () => 0, pasteIntoTerminal: () => false },
      operations: { get: (id: string) => operations.get(id) ?? null },
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

    // 1. GET /api/v1/browser/global/state — operations.get("global") 이 없어도 200 반환 (가짜 Operation 불필요)
    const stateRes = {} as ServerResponse;
    const handledState = await router({
      req: { method: "GET" } as IncomingMessage,
      res: stateRes,
      pathname: "/api/v1/browser/global/state",
    });
    expect(handledState).toBe(true);
    expect((stateRes as unknown as { status: number }).status).toBe(200);
    expect((stateRes as unknown as { body: { owner: { kind: string }; operationId: string } }).body).toMatchObject({
      owner: { kind: "global" },
      operationId: "global",
    });

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

  it("preserves global tabs on operation closure and manages closed-tab suggestions (condition A & Q4)", async () => {
    const engine = new DesktopEngine({ publish: () => {}, log: () => {} });
    const service = new BrowserService({
      enabled: () => true,
      availability: () => ({ available: true, reason: null, host: "local" }),
      desktop: engine,
      log: () => {},
      defaultProfile: { read: () => "default", write: () => {} },
    });

    // Operation 종료가 전역 브라우저 상태에 영향을 주지 않음
    await service.closeOperation("op-target");
    expect(service.globalState().operationId).toBe("global");

    // 닫힌 탭 제안 정리 (dismiss)
    service.dismissClosedTabs();
    expect(service.globalState().closedTabs).toHaveLength(0);
  });
});
