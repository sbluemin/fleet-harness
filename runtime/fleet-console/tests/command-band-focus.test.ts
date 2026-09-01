// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { focusEdgeDockWhenPanelContainsActiveElement } from "../core/client/src/shortcuts.js";

beforeEach(() => document.body.replaceChildren());
afterEach(() => document.body.replaceChildren());

function createPanelWithEdgeDock(panelClass: string, dockClass: string) {
  const dock = document.createElement("button");
  dock.className = dockClass;
  const panel = document.createElement("section");
  panel.className = panelClass;
  const panelControl = document.createElement("button");
  panel.append(panelControl);
  document.body.append(panel, dock);
  return { panel, panelControl, dock };
}

// 접힘 순간의 포커스 인계 — 구 좌표(밴드 토글)는 Periscope에서 퇴역했고, 접힌 뒤에도 남는
// 안정 좌표는 그 패널의 엣지 독 트리거다.
describe("panel collapse focus handoff", () => {
  it.each([
    ["operations-side-bar", "side-bar-edge-dock"],
    ["right-rail", "rail-edge-dock"],
  ])("moves %s internal focus to its edge dock when collapsed", (panelClass, dockClass) => {
    const { panel, panelControl, dock } = createPanelWithEdgeDock(panelClass, dockClass);

    panelControl.focus();
    focusEdgeDockWhenPanelContainsActiveElement(panel, `.${dockClass}`);

    expect(document.activeElement).toBe(dock);
  });

  it("keeps outside focus untouched during repeated collapse notifications", () => {
    const { panel, dock } = createPanelWithEdgeDock("operations-side-bar", "side-bar-edge-dock");

    dock.focus();
    focusEdgeDockWhenPanelContainsActiveElement(panel, ".side-bar-edge-dock");
    focusEdgeDockWhenPanelContainsActiveElement(panel, ".side-bar-edge-dock");

    expect(document.activeElement).toBe(dock);
  });
});
