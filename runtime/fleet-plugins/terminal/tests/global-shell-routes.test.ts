import type { RailCanvasSurfaceContext, RailPanelContext } from "@fleet-console/sdk/rail";
import { describe, expect, it, vi } from "vitest";

import { globalShellPanel } from "../client/global-shell/rail-panel.js";

describe("Shell rail contribution", () => {
  /**
   * Shell은 Operation을 낳지 않는다. 레일 기여가 캔버스 면 갈래로 서야 호스트가 면을 열고,
   * 그렇지 않으면 예전처럼 캔버스에 카드가 태어난다.
   */
  it("contributes a canvas surface instead of a rail panel or an Operation launch", () => {
    expect(globalShellPanel.canvasSurface).toBeDefined();
    expect(globalShellPanel.render).toBeUndefined();
    expect(globalShellPanel.activate).toBeUndefined();
  });

  it("renders nothing until a Theater is settled", () => {
    const ctx = { theaterId: null, visible: true, close: () => undefined } as unknown as RailCanvasSurfaceContext;
    expect(globalShellPanel.canvasSurface?.render(ctx)).toBeNull();
    expect(globalShellPanel.canvasSurface?.renderActions?.(ctx)).toBeNull();
  });

  /**
   * 끝내기는 세션을 Theater id로 지운다 — 면을 닫는 것만으로는 PTY가 끝나지 않기 때문에,
   * 이 경로가 UI에 있는 유일한 출구다.
   */
  it("ends the Theater session by Theater id and then closes the surface", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const close = vi.fn();
    const ctx = {
      theaterId: "theater-a",
      visible: true,
      close,
      api: { fetch: fetchMock },
    } as unknown as RailCanvasSurfaceContext;

    const actions = globalShellPanel.canvasSurface?.renderActions?.(ctx) as
      { readonly props: { readonly onClick: () => void } };
    actions.props.onClick();

    expect(fetchMock).toHaveBeenCalledWith("terminal", "shell/theater-sessions/theater-a", { method: "DELETE" });
  });

  /**
   * 끝내기가 거절되거나 통신이 실패하면 셸은 그대로 살아 있다. 그런데도 면을 접으면 화면만
   * 사라져 "끝냈다"고 말한 셈이 되고, 다시 열었을 때 끝냈다던 세션이 돌아온다.
   */
  it("keeps the surface open when ending the session fails", async () => {
    // 거절 Promise는 소비 시점에 만든다 — 배열에 미리 담으면 아무도 잡기 전에 unhandled로 샌다.
    const outcomes: Array<() => Promise<Response>> = [
      () => Promise.resolve(new Response(null, { status: 500 })),
      () => Promise.reject(new Error("offline")),
    ];
    for (const outcome of outcomes) {
      const close = vi.fn();
      const ctx = {
        theaterId: "theater-a",
        visible: true,
        close,
        api: { fetch: outcome },
      } as unknown as RailCanvasSurfaceContext;

      const actions = globalShellPanel.canvasSurface?.renderActions?.(ctx) as
        { readonly props: { readonly onClick: () => void } };
      actions.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(close).not.toHaveBeenCalled();
    }
  });

  it("closes the surface once the session really ended", async () => {
    const close = vi.fn();
    const ctx = {
      theaterId: "theater-a",
      visible: true,
      close,
      api: { fetch: () => Promise.resolve(new Response(null, { status: 200 })) },
    } as unknown as RailCanvasSurfaceContext;

    const actions = globalShellPanel.canvasSurface?.renderActions?.(ctx) as
      { readonly props: { readonly onClick: () => void } };
    actions.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stays a valid rail descriptor without Operation launching", () => {
    expect(() => globalShellPanel.title).not.toThrow();
    expect((globalShellPanel as { readonly activate?: (ctx: RailPanelContext) => void }).activate).toBeUndefined();
  });
});
