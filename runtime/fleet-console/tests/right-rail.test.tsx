// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const railPanelContextMock = vi.hoisted(() => ({ themes: [] as unknown[] }));

vi.mock("../core/client/src/rail/built-in-panels.js", () => ({
  BUILT_IN_RAIL_PANELS: [
    {
      id: "plans",
      title: "PLANS",
      defaultWidth: 360,
      icon: "P",
      render: (ctx: { readonly theme?: unknown }) => {
        railPanelContextMock.themes.push(ctx.theme);
        return <button className="test-panel-action">Panel action</button>;
      },
    },
    {
      id: "codex",
      title: "CODEX",
      defaultWidth: 420,
      icon: "C",
      render: () => null,
    },
    {
      id: "alerts",
      title: "ALERTS",
      icon: "A",
      render: () => null,
    },
    {
      id: "__proto__",
      title: "SPECIAL",
      icon: "S",
      render: () => null,
    },
  ],
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
  requestRailPanelExtraWidth,
  setActiveRailPanel,
  setRailOverlayAlpha,
  setRailPanelBehavior,
} from "../core/client/src/rail/rail-store.js";
import { setState } from "../core/client/src/store.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  window.localStorage.clear();
  setActiveRailPanel("plans");
  requestRailPanelExtraWidth("plans", null);
  setRailPanelBehavior("push");
  setRailOverlayAlpha(100);
  railPanelContextMock.themes.length = 0;
  setState({ connection: "live", connectionLostAt: null, activeTheme: "instrument" });
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

describe("Right Rail panel context", () => {
  it("supplies the active Console theme and updates it with the store", () => {
    setState({ activeTheme: "chartroom" });
    renderRail();
    expect(railPanelContextMock.themes.at(-1)).toBe("chartroom");

    act(() => setState({ activeTheme: "drydock" }));
    expect(railPanelContextMock.themes.at(-1)).toBe("drydock");
  });
});

describe("Right Rail stale veil focus boundary", () => {
  it("inerts the covered content, moves focus to reconnect, and restores it after inert is removed", () => {
    renderRail();
    const action = container.querySelector<HTMLButtonElement>(".test-panel-action")!;
    action.focus();
    expect(document.activeElement).toBe(action);

    act(() => setState({ connection: "offline", connectionLostAt: 1_000 }));

    const content = container.querySelector<HTMLElement>(".right-rail-panel-content")!;
    const reconnect = container.querySelector<HTMLButtonElement>(".right-rail-stale-veil button")!;
    expect(content.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(reconnect);

    act(() => setState({ connection: "live", connectionLostAt: null }));

    expect(content.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(action);
  });

  it("falls back to the panel body when the original focus target disappeared", () => {
    renderRail();
    const action = container.querySelector<HTMLButtonElement>(".test-panel-action")!;
    action.focus();
    act(() => setState({ connection: "offline", connectionLostAt: 1_000 }));
    act(() => setActiveRailPanel("codex"));
    expect(action.isConnected).toBe(false);

    act(() => setState({ connection: "live", connectionLostAt: null }));

    expect(document.activeElement).toBe(panelBody());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("leaves focus where the user moved it after the stale veil took ownership", () => {
    renderRail();
    const action = container.querySelector<HTMLButtonElement>(".test-panel-action")!;
    action.focus();
    act(() => setState({ connection: "offline", connectionLostAt: 1_000 }));
    const outside = document.createElement("button");
    outside.textContent = "Outside rail";
    document.body.appendChild(outside);
    outside.focus();

    act(() => setState({ connection: "live", connectionLostAt: null }));

    expect(document.activeElement).toBe(outside);
  });

  it("leaves focus unchanged when the stale veil never took ownership", () => {
    renderRail();
    const outside = document.createElement("button");
    outside.textContent = "Outside rail";
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    act(() => setState({ connection: "offline", connectionLostAt: 1_000 }));
    expect(document.activeElement).toBe(outside);

    act(() => setState({ connection: "live", connectionLostAt: null }));

    expect(document.activeElement).toBe(outside);
  });
});

describe("Right Rail panel width", () => {
  it("resolves remembered width before descriptor defaultWidth and the 312 fallback", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ plans: 508 }));
    renderRail();
    expect(renderedPanelWidth()).toBe(508);

    act(() => setActiveRailPanel("codex"));
    expect(renderedPanelWidth()).toBe(420);

    act(() => setActiveRailPanel("alerts"));
    expect(renderedPanelWidth()).toBe(312);
  });

  it("switches immediately between each panel's remembered or default width", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ plans: 480, alerts: 288 }));
    renderRail();
    expect(renderedPanelWidth()).toBe(480);

    act(() => setActiveRailPanel("alerts"));
    expect(renderedPanelWidth()).toBe(288);

    act(() => setActiveRailPanel("plans"));
    expect(renderedPanelWidth()).toBe(480);
  });

  it("persists the active panel width at drag end", () => {
    renderRail();
    const handle = resizeHandle();

    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 600 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 500 }));
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });

    expect(renderedPanelWidth()).toBe(460);
    expect(storedPanelWidths()).toEqual({ plans: 460 });
  });

  it("keeps the in-progress drag width when extra width changes and clamps only to reduced capacity", () => {
    renderRail();
    const handle = resizeHandle();

    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 600 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 400 }));
    });
    expect(reportedPanelWidth()).toBe(560);

    act(() => requestRailPanelExtraWidth("plans", 300));
    expect(reportedPanelWidth()).toBe(560);

    act(() => requestRailPanelExtraWidth("plans", 650));
    expect(reportedPanelWidth()).toBe(402);

    act(() => document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(storedPanelWidths()).toEqual({ plans: 402 });
  });

  it("restores the desired width when capacity returns without persisting the temporary clamp", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ plans: 900 }));
    renderRail();
    expect(reportedPanelWidth()).toBe(900);

    act(() => requestRailPanelExtraWidth("plans", 360));
    expect(reportedPanelWidth()).toBe(692);
    expect(storedPanelWidths()).toEqual({ plans: 900 });

    act(() => requestRailPanelExtraWidth("plans", null));
    expect(reportedPanelWidth()).toBe(900);
    expect(storedPanelWidths()).toEqual({ plans: 900 });
  });

  it("updates ARIA capacity on viewport resize and restores the desired width without persisting the clamp", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ plans: 900 }));
    renderRail();
    expect(reportedPanelWidth()).toBe(900);

    resizeViewport(1000);
    expect(resizeHandle().getAttribute("aria-valuemax")).toBe("852");
    expect(reportedPanelWidth()).toBe(852);
    expect(storedPanelWidths()).toEqual({ plans: 900 });

    resizeViewport(1200);
    expect(resizeHandle().getAttribute("aria-valuemax")).toBe("1052");
    expect(reportedPanelWidth()).toBe(900);
    expect(storedPanelWidths()).toEqual({ plans: 900 });
  });

  it("exposes separator values and persists keyboard resizing with the right-rail direction", () => {
    renderRail();
    const handle = resizeHandle();
    expect(handle).toMatchObject({
      tabIndex: 0,
    });
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize PLANS panel");
    expect(handle.getAttribute("aria-controls")).toBe("rail-panel-plans");
    expect(document.getElementById(handle.getAttribute("aria-controls")!)).toBe(panelBody());
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("1052");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");

    expect(dispatchResizeKey(handle, "ArrowLeft")).toBe(false);
    expect(renderedPanelWidth()).toBe(376);
    expect(storedPanelWidths()).toEqual({ plans: 376 });

    expect(dispatchResizeKey(handle, "ArrowRight", true)).toBe(false);
    expect(renderedPanelWidth()).toBe(312);

    dispatchResizeKey(handle, "Home");
    expect(renderedPanelWidth()).toBe(240);

    dispatchResizeKey(handle, "End");
    expect(renderedPanelWidth()).toBe(1052);
    expect(handle.getAttribute("aria-valuenow")).toBe("1052");
    expect(storedPanelWidths()).toEqual({ plans: 1052 });
  });

  it("migrates the legacy width once to the active panel and removes the legacy key", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidth", "500");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    renderRail();

    expect(renderedPanelWidth()).toBe(500);
    expect(storedPanelWidths()).toEqual({ plans: 500 });
    expect(window.localStorage.getItem("fleet-console.rail.panelWidth")).toBeNull();

    act(() => setActiveRailPanel("alerts"));
    expect(removeItem.mock.calls.filter(([key]) => key === "fleet-console.rail.panelWidth")).toHaveLength(1);
  });

  it("preserves an oversized legacy width in the panel map and restores it when the viewport can fit it", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    window.localStorage.setItem("fleet-console.rail.panelWidth", "900");
    renderRail();

    expect(storedPanelWidths()).toEqual({ plans: 900 });
    expect(window.localStorage.getItem("fleet-console.rail.panelWidth")).toBeNull();
    expect(reportedPanelWidth()).toBe(360);

    resizeViewport(1200);
    expect(reportedPanelWidth()).toBe(900);
    expect(storedPanelWidths()).toEqual({ plans: 900 });
  });

  it("preserves legacy width for a missing descriptor and migrates after a valid panel becomes active", () => {
    setActiveRailPanel("missing-plugin");
    window.localStorage.setItem("fleet-console.rail.panelWidth", "640");
    renderRail();

    expect(window.localStorage.getItem("fleet-console.rail.panelWidth")).toBe("640");
    expect(window.localStorage.getItem("fleet-console.rail.panelWidths")).toBeNull();

    act(() => setActiveRailPanel("plans"));
    expect(renderedPanelWidth()).toBe(640);
    expect(storedPanelWidths()).toEqual({ plans: 640 });
    expect(window.localStorage.getItem("fleet-console.rail.panelWidth")).toBeNull();
  });

  it("stores a special panel id from an empty width record", () => {
    setActiveRailPanel("__proto__");
    renderRail();

    dispatchResizeKey(resizeHandle(), "ArrowLeft");
    const stored = storedPanelWidths();
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(true);
    expect(stored["__proto__"]).toBe(328);
  });

  it.each([
    ["non-JSON record", "not-json"],
    ["non-number width", JSON.stringify({ plans: "wide" })],
    ["below-minimum width", JSON.stringify({ plans: 200 })],
    ["above-maximum width", JSON.stringify({ plans: 1100 })],
  ])("falls back without crashing for a corrupted %s", (_label, stored) => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", stored);
    expect(() => renderRail()).not.toThrow();
    expect(renderedPanelWidth()).toBe(360);
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

function panelBody(): HTMLDivElement {
  const body = container.querySelector<HTMLDivElement>(".right-rail-panel-body");
  expect(body).not.toBeNull();
  return body!;
}

function renderedPanelWidth(): number {
  const rail = container.querySelector<HTMLElement>(".right-rail");
  expect(rail).not.toBeNull();
  return Number.parseInt(rail!.style.getPropertyValue("--right-rail-panel-width"), 10);
}

function resizeHandle(): HTMLDivElement {
  const handle = container.querySelector<HTMLDivElement>(".right-rail-resize-handle");
  expect(handle).not.toBeNull();
  return handle!;
}

function reportedPanelWidth(): number {
  return Number(resizeHandle().getAttribute("aria-valuenow"));
}

function resizeViewport(width: number): void {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}

function dispatchResizeKey(handle: HTMLElement, key: string, shiftKey = false): boolean {
  let result = true;
  act(() => {
    result = handle.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      shiftKey,
    }));
  });
  return result;
}

function storedPanelWidths(): Record<string, number> {
  return JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths") ?? "{}") as Record<string, number>;
}
