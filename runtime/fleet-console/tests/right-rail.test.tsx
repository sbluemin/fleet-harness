// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/rail/built-in-panels.js", () => ({
  BUILT_IN_RAIL_PANELS: [{
    id: "plans",
    title: "PLANS",
    icon: "P",
    render: () => null,
  }],
}));

vi.mock("../core/client/src/rail/rail-registry.js", () => ({
  useRailPanels: () => [],
}));

vi.mock("../core/client/src/rail/use-codex-split-extra-width.js", () => ({
  useCodexSplitExtraWidth: () => 0,
}));

import { RightRail } from "../core/client/src/rail/right-rail.js";
import {
  getRailStoreSnapshot,
  setActiveRailPanel,
  setRailOverlayAlpha,
  setRailPanelBehavior,
} from "../core/client/src/rail/rail-store.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  setActiveRailPanel("plans");
  setRailPanelBehavior("push");
  setRailOverlayAlpha(100);
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Right Rail overlay opacity presets", () => {
  it("renders no opacity group or alpha variable in push mode", () => {
    renderRail();

    expect(container.querySelector('[role="group"][aria-label="Panel opacity"]')).toBeNull();
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("");
  });

  it("renders the exact presets in overlay mode and applies selection to the slot background variable", () => {
    setRailPanelBehavior("overlay");
    renderRail();

    const group = container.querySelector<HTMLElement>('[role="group"][aria-label="Panel opacity"]');
    expect(group).not.toBeNull();
    const buttons = Array.from(group!.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Solid", "90", "75", "60"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("1");

    act(() => buttons[2]?.click());

    expect(getRailStoreSnapshot().overlayAlpha).toBe(75);
    expect(window.localStorage.getItem("fleet-console.rail.overlayAlpha")).toBe("75");
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "true", "false"]);
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("0.75");
  });
});

function renderRail(): void {
  act(() => {
    root.render(<RightRail theaterId={null} api={{} as never} />);
  });
}

function panelSlot(): HTMLDivElement {
  const slot = container.querySelector<HTMLDivElement>(".right-rail-panel-slot");
  expect(slot).not.toBeNull();
  return slot!;
}
