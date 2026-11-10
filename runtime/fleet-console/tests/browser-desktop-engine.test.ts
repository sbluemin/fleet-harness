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
    // 생성 직후 sizes 가 그 뷰의 실행 크기이고, 0×0 창으로 말하지 않는다.
    expect(engine.viewSize(targetId)).toEqual({ width: 1440, height: 900, scale: 2 });
    await expect(engine.send("Browser.getWindowForTarget", { targetId })).resolves.toMatchObject({ bounds: { width: 1440, height: 900 } });
    engine.bindView(targetId, "op-1");
    const { sessionId } = await engine.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    expect(sessionId).toBe(targetId);

    // 표면이 없으면 표시 탭도 보이지 않는다. 자리와 크기는 셸이 정하므로 Console 은 bounds 를 싣지 않는다.
    await engine.send("Target.activateTarget", { targetId });
    expect(published.at(-1)?.views[0]).toMatchObject({ visible: false });
    expect(published.at(-1)?.views[0]).not.toHaveProperty("bounds");
    // 표면은 한 번에 하나의 브라우저만 갖는다. 열기는 멱등이고 다른 브라우저는 막힌다.
    const lease = engine.openSurface("op-1", "pane");
    expect(engine.openSurface("op-1", "window")).toBe(lease);
    expect(() => engine.openSurface("op-2", "pane")).toThrow("browser_surface_busy");
    expect(published.at(-1)?.views[0]).toMatchObject({ id: targetId, partition: context.browserContextId, visible: true });
    expect(published.at(-1)?.surface).toMatchObject({ id: lease.id, browserId: "op-1", mode: "pane" });
    engine.setChrome({ browserId: "op-1", spaces: [], tabs: [], activeTabId: null, viewport: { preset: "responsive", width: 1, height: 1, setBy: null }, driving: false, profile: null, defaultProfile: null, available: true, reason: null });
    expect(published.at(-1)?.chrome?.browserId).toBe("op-1");
    // 모드·포커스는 현재 표면에만 닿는다. 낡은 id 는 무시된다.
    engine.setSurfaceMode("stale", "window");
    expect(engine.surfaceState()?.mode).toBe("pane");
    engine.setSurfaceMode(lease.id, "window");
    engine.focusSurface("stale");
    engine.focusSurface(lease.id);
    engine.focusSurface(lease.id);
    expect(engine.surfaceState()).toMatchObject({ id: lease.id, mode: "window", focusRequest: 2 });
    // 셸이 표면을 닫았다고 알리면 호스트의 relay 만 받는다. 표면이 닫히면 뷰도 내려가고 크롬은 스냅샷에서 빠진다.
    engine.relay("remote-guest", { surface: { id: lease.id, status: "closed" } });
    expect(engine.surfaceState()?.id).toBe(lease.id);
    engine.relay("local", { surface: { id: lease.id, status: "closed" } });
    expect(engine.surfaceState()).toBeNull();
    expect(published.at(-1)?.views[0]).toMatchObject({ visible: false });
    expect(published.at(-1)?.chrome).toBeNull();
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

    // 페이지의 confirm 이 뜨면 렌더러가 멈춘다 — 기다리던 명령은 60초 대신 곧바로 대화상자 안내로 끝나고, 답하기 전의
    // 명령은 거절되며 답하는 명령만 나간다. 닫히면 다시 열린다.
    const clicking = engine.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1 }, sessionId);
    engine.relay("local", { events: [{ viewId: targetId, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Run build?" } }] });
    await expect(clicking).rejects.toThrow(/confirm dialog is open.*"Run build\?".*accept_dialog/s);
    expect(engine.viewDialog(targetId)).toEqual({ type: "confirm", message: "Run build?" });
    await expect(engine.send("Runtime.evaluate", { expression: "1" }, sessionId)).rejects.toThrow(/confirm dialog is open/);
    void engine.send("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => undefined);
    expect(published.at(-1)?.commands.map((entry) => entry.method)).toEqual(["Page.handleJavaScriptDialog"]);
    engine.relay("local", { results: [{ id: published.at(-1)!.commands[0]!.id, result: {} }], events: [{ viewId: targetId, method: "Page.javascriptDialogClosed", params: { result: true } }] });
    expect(engine.viewDialog(targetId)).toBeNull();

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
    engine.openSurface("op-1", "pane");
    expect(engine.setHost("remote-guest")).toBe(true);
    await Promise.resolve();
    expect(handedOff).toBe(true);
    expect(engine.currentHost).toBe("remote-guest");
    expect(engine.connected).toBe(true);
    expect(published.at(-1)?.views).toHaveLength(0);
    expect(engine.surfaceState()).toBeNull();
  });
});
