// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RailCanvasSurfaceContext, RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { CanvasSurfaceSheet } from "../core/client/src/components/canvas-surface-sheet.js";
import { closeCanvasSurface, getCanvasSurfacePanelId, openCanvasSurface } from "../core/client/src/canvas-surface-store.js";

/**
 * `close`는 "이 면"만 접는다고 계약에 적혀 있다. 비동기 작업이 끝난 뒤 부르는 자리를 위한
 * 약속이므로, 그 사이 면이 바뀌었다면 아무 일도 일어나지 않아야 한다.
 */
describe("canvas surface close scope", () => {
  let host: HTMLDivElement;
  let root: Root;
  const captured: RailCanvasSurfaceContext[] = [];

  const panel: RailPanelDescriptor = {
    id: "probe",
    title: "Probe",
    icon: null,
    canvasSurface: {
      render: (ctx) => { captured.push(ctx); return null; },
    },
  };

  beforeEach(() => {
    captured.length = 0;
    document.body.innerHTML = "";
    const canvas = document.createElement("div");
    canvas.className = "operations-canvas";
    document.body.appendChild(canvas);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    closeCanvasSurface();
  });

  afterEach(() => {
    act(() => root.unmount());
    closeCanvasSurface();
  });

  function render(theaterId: string | null) {
    const baseCtx = { theaterId, api: {} } as unknown as RailPanelContext;
    act(() => root.render(
      <CanvasSurfaceSheet panels={[panel]} baseCtx={baseCtx} language="en" />,
    ));
  }

  it("ignores a close from a surface that was already dismissed and reopened", () => {
    act(() => openCanvasSurface("probe"));
    render("theater-a");
    const stale = captured.at(-1)!;

    act(() => closeCanvasSurface());
    act(() => openCanvasSurface("probe"));
    render("theater-a");
    expect(getCanvasSurfacePanelId()).toBe("probe");

    act(() => stale.close());

    expect(getCanvasSurfacePanelId()).toBe("probe");
  });

  /**
   * Theater 값을 신원에 그대로 쓰면 A→B→A가 처음 A와 같아져, 첫 A의 완료가 두 번째 A를 접는다.
   */
  it("ignores a close from the first visit to a Theater after leaving and coming back", () => {
    act(() => openCanvasSurface("probe"));
    render("theater-a");
    const staleOnFirstA = captured.at(-1)!;

    render("theater-b");
    render("theater-a");
    expect(getCanvasSurfacePanelId()).toBe("probe");

    act(() => staleOnFirstA.close());

    expect(getCanvasSurfacePanelId()).toBe("probe");
  });

  it("still closes the surface the caller was actually given", () => {
    act(() => openCanvasSurface("probe"));
    render("theater-a");
    const current = captured.at(-1)!;

    act(() => current.close());

    expect(getCanvasSurfacePanelId()).toBeNull();
  });
});
