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

  it("stays a valid rail descriptor without Operation launching", () => {
    expect(() => globalShellPanel.title).not.toThrow();
    expect((globalShellPanel as { readonly activate?: (ctx: RailPanelContext) => void }).activate).toBeUndefined();
  });
});
