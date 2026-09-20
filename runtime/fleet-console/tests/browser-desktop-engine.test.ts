import { describe, expect, it, vi } from "vitest";
import type { DesktopBrowserSnapshot } from "@fleet-console/protocol/desktop";

import { DesktopEngine } from "../features/browser/host/desktop-engine.js";

/**
 * 네이티브 뷰 엔진의 수명 계약 — 호스트 셸이 붙어 있는 동안 탭 생성이 뷰 생성·부착으로 풀리고, 세션 명령이 스냅샷으로
 * 나가 relay 로 답을 받으며, 호스트가 아닌 셸의 relay 는 무시되고, 호스트가 바뀌거나 떨어지면 기다리던 모든 것이 실패하고
 * 엔진이 닫힌다. BrowserService 가 꽂히는 유일한 엔진이라 여기서 한 번만 검증한다.
 */
describe("desktop native browser engine", () => {
  it("turns a tab into an attached view, relays session commands, and closes when the shell leaves", async () => {
    const published: DesktopBrowserSnapshot[] = [];
    const engine = new DesktopEngine({ publish: (snapshot) => published.push(snapshot), log: () => {} });
    engine.subscriberOpened("local");
    engine.setHost("local");
    engine.relay("local", { hello: { product: "Chrome/150.0", userAgent: "Mozilla/5.0 Chrome/150.0" } });
    const context = await engine.send<{ browserContextId: string }>("Target.createBrowserContext", {});

    // 뷰 생성은 셸이 부착을 알릴 때까지 기다린다.
    const creating = engine.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
    const pendingView = published.at(-1)?.views[0];
    expect(pendingView?.partition).toBe(context.browserContextId);
    expect(pendingView?.visible).toBe(false);
    // 호스트가 아닌 셸(원격 관전 창)의 relay 는 무시된다 — 그 창에는 이 뷰가 없다.
    engine.subscriberOpened("remote-guest");
    engine.relay("remote-guest", { attached: [pendingView!.id] });
    expect(published.at(-1)?.views[0]?.id).toBe(pendingView!.id);
    engine.relay("local", { attached: [pendingView!.id], sizes: [{ viewId: pendingView!.id, width: 1440, height: 900, scale: 2 }] });
    const { targetId } = await creating;
    expect(targetId).toBe(pendingView!.id);
    // Companion 이 없어도 생성 직후 sizes 가 그 뷰의 실행 크기이고, 0×0 창으로 말하지 않는다.
    expect(engine.viewSize(targetId)).toEqual({ width: 1440, height: 900, scale: 2 });
    await expect(engine.send("Browser.getWindowForTarget", { targetId })).resolves.toMatchObject({ bounds: { width: 1440, height: 900 } });
    engine.bindView(targetId, "op-1");
    const { sessionId } = await engine.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    expect(sessionId).toBe(targetId);

    // 활성 탭이 자리를 받으면 보이고, 세션 명령은 스냅샷에 실려 나가 relay 로 답을 받는다.
    await engine.send("Target.activateTarget", { targetId });
    engine.place("op-1", { bounds: { x: 10, y: 20, width: 300, height: 200 }, visible: true });
    expect(published.at(-1)?.views[0]).toMatchObject({ visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } });
    // Companion 을 닫아도 placement 크기(실행 뷰포트)는 남고 presentation 만 내린다.
    engine.place("op-1", null);
    expect(published.at(-1)?.views[0]).toMatchObject({ visible: false, bounds: { x: 10, y: 20, width: 300, height: 200 } });
    engine.place("op-1", { bounds: { x: 10, y: 20, width: 300, height: 200 }, visible: true });
    const evaluating = engine.send<{ result: { value: number } }>("Runtime.evaluate", { expression: "1+1", browserContextId: "stripped" }, sessionId);
    const command = published.at(-1)?.commands[0];
    expect(command).toMatchObject({ viewId: targetId, method: "Runtime.evaluate", params: { expression: "1+1" } });
    engine.relay("local", { results: [{ id: command!.id, result: { result: { value: 2 } } }] });
    await expect(evaluating).resolves.toEqual({ result: { value: 2 } });
    expect(published.at(-1)?.commands).toHaveLength(0);

    // 페이지 이벤트는 뷰 id 를 세션으로 달고 올라온다.
    const events: string[] = [];
    engine.on((event) => events.push(`${event.sessionId}:${event.method}`));
    engine.relay("local", { events: [{ viewId: targetId, method: "Page.frameNavigated", params: { frame: { id: "f" } } }] });
    expect(events).toEqual([`${targetId}:Page.frameNavigated`]);

    // 스트림이 잠깐 끊겼다 돌아오면 뷰와 명령은 그대로다 — 절전·순단은 창이 닫힌 것이 아니다.
    vi.useFakeTimers();
    try {
      const orphaned = engine.send("Runtime.evaluate", { expression: "2" }, sessionId);
      engine.subscriberClosed("local");
      expect(engine.connected).toBe(true);
      vi.advanceTimersByTime(1_000);
      engine.subscriberOpened("local");
      expect(published.at(-1)?.views).toHaveLength(1);
      // 셸이 정말 떠나면(유예 경과) 기다리던 명령은 실패하고 엔진은 닫힌다 — 서비스가 탭을 접는 신호다.
      let closed = false;
      void engine.closed.then(() => { closed = true; });
      engine.subscriberClosed("local");
      vi.advanceTimersByTime(6_000);
      await expect(orphaned).rejects.toThrow(/desktop_browser_disconnected|desktop_view_closed/);
      await Promise.resolve();
      expect(closed).toBe(true);
      expect(engine.connected).toBe(false);
      await expect(engine.send("Runtime.evaluate", {}, sessionId)).rejects.toThrow(/desktop_browser_disconnected/);
    } finally { vi.useRealTimers(); }

    // 제어가 원격 Desktop 으로 넘어가면 그 창이 호스트다 — 이 기계의 창에 살던 뷰는 옮길 수 없으므로 닫힌다.
    engine.subscriberOpened("local");
    const nextContext = await engine.send<{ browserContextId: string }>("Target.createBrowserContext", {});
    const recreating = engine.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: nextContext.browserContextId });
    engine.relay("local", { attached: [published.at(-1)!.views[0]!.id] });
    await recreating;
    let handedOff = false;
    void engine.closed.then(() => { handedOff = true; });
    expect(engine.setHost("remote-guest")).toBe(true);
    await Promise.resolve();
    expect(handedOff).toBe(true);
    expect(engine.currentHost).toBe("remote-guest");
    expect(engine.connected).toBe(true);
    expect(published.at(-1)?.views).toHaveLength(0);
  });
});
