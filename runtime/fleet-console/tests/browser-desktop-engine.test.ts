import { describe, expect, it, vi } from "vitest";
import type { DesktopBrowserSnapshot } from "@fleet-console/desktop-protocol";

import { DesktopEngine } from "../core/host/browser/desktop-engine.js";

/**
 * 네이티브 뷰 엔진의 수명 계약 — 셸이 붙어 있는 동안 탭 생성이 뷰 생성·부착으로 풀리고, 세션 명령이 스냅샷으로 나가
 * relay 로 답을 받으며, 셸이 떨어지면 기다리던 모든 것이 실패하고 엔진이 닫힌다. 헤드리스 엔진과 같은 얼굴로
 * BrowserService 에 꽂히는 유일한 지점이라 여기서 한 번만 검증한다.
 */
describe("desktop native browser engine", () => {
  it("turns a tab into an attached view, relays session commands, and closes when the shell leaves", async () => {
    const published: DesktopBrowserSnapshot[] = [];
    const engine = new DesktopEngine({ publish: (snapshot) => published.push(snapshot), log: () => {} });
    engine.subscriberOpened();
    engine.relay({ hello: { product: "Chrome/150.0", userAgent: "Mozilla/5.0 Chrome/150.0" } });
    const context = await engine.send<{ browserContextId: string }>("Target.createBrowserContext", {});

    // 뷰 생성은 셸이 부착을 알릴 때까지 기다린다.
    const creating = engine.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
    const pendingView = published.at(-1)?.views[0];
    expect(pendingView?.partition).toBe(context.browserContextId);
    expect(pendingView?.visible).toBe(false);
    engine.relay({ attached: [pendingView!.id] });
    const { targetId } = await creating;
    expect(targetId).toBe(pendingView!.id);
    engine.bindView(targetId, "op-1");
    const { sessionId } = await engine.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    expect(sessionId).toBe(targetId);

    // 활성 탭이 자리를 받으면 보이고, 세션 명령은 스냅샷에 실려 나가 relay 로 답을 받는다.
    await engine.send("Target.activateTarget", { targetId });
    engine.place("op-1", { bounds: { x: 10, y: 20, width: 300, height: 200 }, visible: true });
    expect(published.at(-1)?.views[0]).toMatchObject({ visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } });
    const evaluating = engine.send<{ result: { value: number } }>("Runtime.evaluate", { expression: "1+1", browserContextId: "stripped" }, sessionId);
    const command = published.at(-1)?.commands[0];
    expect(command).toMatchObject({ viewId: targetId, method: "Runtime.evaluate", params: { expression: "1+1" } });
    engine.relay({ results: [{ id: command!.id, result: { result: { value: 2 } } }] });
    await expect(evaluating).resolves.toEqual({ result: { value: 2 } });
    expect(published.at(-1)?.commands).toHaveLength(0);

    // 페이지 이벤트는 뷰 id 를 세션으로 달고 올라온다.
    const events: string[] = [];
    engine.on((event) => events.push(`${event.sessionId}:${event.method}`));
    engine.relay({ events: [{ viewId: targetId, method: "Page.frameNavigated", params: { frame: { id: "f" } } }] });
    expect(events).toEqual([`${targetId}:Page.frameNavigated`]);

    // 스트림이 잠깐 끊겼다 돌아오면 뷰와 명령은 그대로다 — 절전·순단은 창이 닫힌 것이 아니다.
    vi.useFakeTimers();
    try {
      const orphaned = engine.send("Runtime.evaluate", { expression: "2" }, sessionId);
      engine.subscriberClosed();
      expect(engine.connected).toBe(true);
      vi.advanceTimersByTime(1_000);
      engine.subscriberOpened();
      expect(published.at(-1)?.views).toHaveLength(1);
      // 셸이 정말 떠나면(유예 경과) 기다리던 명령은 실패하고 엔진은 닫힌다 — 서비스가 탭을 접는 신호다.
      let closed = false;
      void engine.closed.then(() => { closed = true; });
      engine.subscriberClosed();
      vi.advanceTimersByTime(6_000);
      await expect(orphaned).rejects.toThrow(/desktop_browser_disconnected|desktop_view_closed/);
      await Promise.resolve();
      expect(closed).toBe(true);
      expect(engine.connected).toBe(false);
      await expect(engine.send("Runtime.evaluate", {}, sessionId)).rejects.toThrow(/desktop_browser_disconnected/);
    } finally { vi.useRealTimers(); }
  });
});
