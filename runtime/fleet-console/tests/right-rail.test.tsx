// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const railPanelContextMock = vi.hoisted(() => ({ themes: [] as unknown[], renderCount: 0, activate: vi.fn() }));

vi.mock("../core/client/src/rail/built-in-panels.js", () => ({
  BUILT_IN_RAIL_PANELS: [
    {
      id: "repository",
      title: "REPOSITORY",
      defaultWidth: 360,
      icon: "P",
      render: (ctx: { readonly theme?: unknown }) => {
        railPanelContextMock.renderCount += 1;
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
  useRailPanels: () => [
    {
      id: "shell-action",
      title: "SHELL",
      icon: "H",
      surfaceId: "shell",
      activate: railPanelContextMock.activate,
    },
    {
      id: "plain-action",
      title: "PLAIN",
      icon: "N",
      activate: () => undefined,
    },
    {
      id: "file-explorer",
      title: "FILES",
      icon: "F",
      render: () => null,
    },
  ],
}));

import { RightRail } from "../core/client/src/rail/right-rail.js";
import {
  getRailStoreSnapshot,
  requestRailPanelExtraWidth,
  setActiveRailPanel,
  setRailOverlayAlpha,
  setRailPanelBehavior,
} from "../core/client/src/rail/rail-store.js";
import {
  closeExpandedSurfacesOf,
  openExpandedSurface,
  resetExpandedSurfacesForTest,
} from "../core/client/src/expanded-surface/store.js";
import { setState } from "../core/client/src/store.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  window.localStorage.clear();
  setActiveRailPanel("repository");
  requestRailPanelExtraWidth("repository", null);
  setRailPanelBehavior("push");
  setRailOverlayAlpha(100);
  railPanelContextMock.themes.length = 0;
  railPanelContextMock.renderCount = 0;
  railPanelContextMock.activate.mockClear();
  setState({ connection: "live", connectionLostAt: null, activeTheme: "instrument" });
  resetExpandedSurfacesForTest();
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Right Rail overlay opacity slider", () => {
  it("renders no opacity slider or alpha variable in push mode", () => {
    renderRail();

    expect(container.querySelector('input[aria-label="Panel opacity"]')).toBeNull();
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("");
  });

  it("renders the slider in overlay mode, applies changes, and resets on double-click", () => {
    setRailPanelBehavior("overlay");
    renderRail();

    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Panel opacity"]');
    expect(slider).not.toBeNull();
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("1");

    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(slider, "65");
      slider!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(getRailStoreSnapshot().overlayAlpha).toBe(65);
    expect(window.localStorage.getItem("fleet-console.rail.overlayAlpha")).toBe("65");
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("0.65");

    act(() => slider!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(getRailStoreSnapshot().overlayAlpha).toBe(100);
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("1");
  });

  it("does not re-render the panel body while the opacity slider changes", () => {
    setRailPanelBehavior("overlay");
    renderRail();

    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Panel opacity"]')!;
    const renderCountBeforeChange = railPanelContextMock.renderCount;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(slider, "65");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(getRailStoreSnapshot().overlayAlpha).toBe(65);
    expect(railPanelContextMock.renderCount).toBe(renderCountBeforeChange);
  });
});

describe("Right Rail panel context", () => {
  it("supplies the active Console theme and updates it with the store", () => {
    setState({ activeTheme: "whites" });
    renderRail();
    expect(railPanelContextMock.themes.at(-1)).toBe("whites");

    act(() => setState({ activeTheme: "carbon" }));
    expect(railPanelContextMock.themes.at(-1)).toBe("carbon");
  });

  it("disables action icons until a Theater is active", () => {
    renderRail();
    const action = container.querySelector<HTMLButtonElement>("#rail-tab-shell-action")!;

    expect(action.disabled).toBe(true);
    act(() => action.click());

    expect(railPanelContextMock.activate).not.toHaveBeenCalled();
    expect(container.querySelector("#rail-panel-repository")).not.toBeNull();
  });

  it("runs action icons above plugin panels without opening a rail panel", () => {
    renderRail("theater-a");
    const action = container.querySelector<HTMLButtonElement>("#rail-tab-shell-action")!;

    expect(action.disabled).toBe(false);
    act(() => action.click());

    expect(railPanelContextMock.activate).toHaveBeenCalledWith(expect.objectContaining({ theaterId: "theater-a" }));
    expect(container.querySelector("#rail-panel-repository")).not.toBeNull();
    expect(action.getAttribute("role")).toBe("button");
    expect(action.hasAttribute("aria-selected")).toBe(false);
    const icons = Array.from(container.querySelectorAll<HTMLElement>(".right-rail-ico"));
    expect(icons.indexOf(action)).toBeLessThan(icons.indexOf(container.querySelector<HTMLElement>("#rail-tab-file-explorer")!));
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
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 508 }));
    renderRail();
    expect(renderedPanelWidth()).toBe(508);

    act(() => setActiveRailPanel("codex"));
    expect(renderedPanelWidth()).toBe(420);

    act(() => setActiveRailPanel("alerts"));
    expect(renderedPanelWidth()).toBe(312);
  });

  it("switches immediately between each panel's remembered or default width", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 480, alerts: 288 }));
    renderRail();
    expect(renderedPanelWidth()).toBe(480);

    act(() => setActiveRailPanel("alerts"));
    expect(renderedPanelWidth()).toBe(288);

    act(() => setActiveRailPanel("repository"));
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
    expect(storedPanelWidths()).toEqual({ repository: 460 });
  });

  it("keeps the in-progress drag width when extra width changes and clamps only to reduced capacity", () => {
    renderRail();
    const handle = resizeHandle();

    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 600 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 400 }));
    });
    expect(reportedPanelWidth()).toBe(560);

    act(() => requestRailPanelExtraWidth("repository", 300));
    expect(reportedPanelWidth()).toBe(560);

    act(() => requestRailPanelExtraWidth("repository", 650));
    expect(reportedPanelWidth()).toBe(402);

    act(() => document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(storedPanelWidths()).toEqual({ repository: 402 });
  });

  it("restores the desired width when capacity returns without persisting the temporary clamp", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 900 }));
    renderRail();
    expect(reportedPanelWidth()).toBe(900);

    act(() => requestRailPanelExtraWidth("repository", 360));
    expect(reportedPanelWidth()).toBe(692);
    expect(storedPanelWidths()).toEqual({ repository: 900 });

    act(() => requestRailPanelExtraWidth("repository", null));
    expect(reportedPanelWidth()).toBe(900);
    expect(storedPanelWidths()).toEqual({ repository: 900 });
  });

  it("updates ARIA capacity on viewport resize and restores the desired width without persisting the clamp", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 900 }));
    renderRail();
    expect(reportedPanelWidth()).toBe(900);

    resizeViewport(1000);
    expect(resizeHandle().getAttribute("aria-valuemax")).toBe("852");
    expect(reportedPanelWidth()).toBe(852);
    expect(storedPanelWidths()).toEqual({ repository: 900 });

    resizeViewport(1200);
    expect(resizeHandle().getAttribute("aria-valuemax")).toBe("1052");
    expect(reportedPanelWidth()).toBe(900);
    expect(storedPanelWidths()).toEqual({ repository: 900 });
  });

  it("exposes separator values and persists keyboard resizing with the right-rail direction", () => {
    renderRail();
    const handle = resizeHandle();
    expect(handle).toMatchObject({
      tabIndex: 0,
    });
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize REPOSITORY panel");
    expect(handle.getAttribute("aria-controls")).toBe("rail-panel-repository");
    expect(document.getElementById(handle.getAttribute("aria-controls")!)).toBe(panelBody());
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("1052");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");

    expect(dispatchResizeKey(handle, "ArrowLeft")).toBe(false);
    expect(renderedPanelWidth()).toBe(376);
    expect(storedPanelWidths()).toEqual({ repository: 376 });

    expect(dispatchResizeKey(handle, "ArrowRight", true)).toBe(false);
    expect(renderedPanelWidth()).toBe(312);

    dispatchResizeKey(handle, "Home");
    expect(renderedPanelWidth()).toBe(240);

    dispatchResizeKey(handle, "End");
    expect(renderedPanelWidth()).toBe(1052);
    expect(handle.getAttribute("aria-valuenow")).toBe("1052");
    expect(storedPanelWidths()).toEqual({ repository: 1052 });
  });

  it("migrates the legacy width once to the active panel and removes the legacy key", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidth", "500");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    renderRail();

    expect(renderedPanelWidth()).toBe(500);
    expect(storedPanelWidths()).toEqual({ repository: 500 });
    expect(window.localStorage.getItem("fleet-console.rail.panelWidth")).toBeNull();

    act(() => setActiveRailPanel("alerts"));
    expect(removeItem.mock.calls.filter(([key]) => key === "fleet-console.rail.panelWidth")).toHaveLength(1);
  });

  it("preserves an oversized legacy width in the panel map and restores it when the viewport can fit it", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    window.localStorage.setItem("fleet-console.rail.panelWidth", "900");
    renderRail();

    expect(storedPanelWidths()).toEqual({ repository: 900 });
    expect(window.localStorage.getItem("fleet-console.rail.panelWidth")).toBeNull();
    expect(reportedPanelWidth()).toBe(360);

    resizeViewport(1200);
    expect(reportedPanelWidth()).toBe(900);
    expect(storedPanelWidths()).toEqual({ repository: 900 });
  });

  it("preserves legacy width for a missing descriptor and migrates after a valid panel becomes active", () => {
    setActiveRailPanel("missing-plugin");
    window.localStorage.setItem("fleet-console.rail.panelWidth", "640");
    renderRail();

    expect(window.localStorage.getItem("fleet-console.rail.panelWidth")).toBe("640");
    expect(window.localStorage.getItem("fleet-console.rail.panelWidths")).toBeNull();

    act(() => setActiveRailPanel("repository"));
    expect(renderedPanelWidth()).toBe(640);
    expect(storedPanelWidths()).toEqual({ repository: 640 });
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
    ["non-number width", JSON.stringify({ repository: "wide" })],
    ["below-minimum width", JSON.stringify({ repository: 200 })],
    ["above-maximum width", JSON.stringify({ repository: 1100 })],
  ])("falls back without crashing for a corrupted %s", (_label, stored) => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", stored);
    expect(() => renderRail()).not.toThrow();
    expect(renderedPanelWidth()).toBe(360);
  });
});

describe("Right Rail hover-reveal header", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the header hidden until a delayed pointer approach, then hides immediately on leave", () => {
    renderRail();
    const reveal = panelHeadReveal();
    expect(reveal.classList.contains("is-revealed")).toBe(false);
    expect(container.querySelector(".right-rail-panel-peek")).not.toBeNull();

    dispatchSlotPointer("pointermove", { clientY: 104 });
    expect(reveal.classList.contains("is-revealed")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(reveal.classList.contains("is-revealed")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(reveal.classList.contains("is-revealed")).toBe(true);

    dispatchSlotPointer("pointermove", { clientY: 180 });
    expect(reveal.classList.contains("is-revealed")).toBe(false);
  });

  it("does not start a reveal from a touch pointermove", () => {
    renderRail();
    dispatchSlotPointer("pointermove", { clientY: 104, pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(false);
  });

  it("reveals from a touch on the top edge and hides when the body is tapped", () => {
    renderRail();
    dispatchSlotPointer("pointerdown", { clientY: 120, pointerType: "touch" });
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(true);

    dispatchSlotPointer("pointerdown", { clientY: 240, pointerType: "touch" });
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(false);
  });

  it("keeps a touch reveal open through the lift so a second tap can reach the chrome", () => {
    renderRail();
    dispatchSlotPointer("pointerdown", { clientY: 120, pointerType: "touch" });
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(true);

    dispatchSlotPointer("pointerleave", { clientY: 120, pointerType: "touch" });
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(true);

    act(() => {
      panelHeadReveal().dispatchEvent(new PointerEvent("pointerleave", {
        bubbles: true,
        cancelable: true,
        clientX: 980,
        clientY: 110,
        pointerType: "touch",
      }));
    });
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(true);
  });

  it("resets the reveal when the active panel changes", () => {
    renderRail();
    dispatchSlotPointer("pointermove", { clientY: 104 });
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(true);

    act(() => setActiveRailPanel("codex"));
    expect(panelHeadReveal().classList.contains("is-revealed")).toBe(false);
  });
});

function renderRail(theaterId: string | null = null): void {
  act(() => {
    root.render(<RightRail theaterId={theaterId} api={{} as never} />);
  });
}

function panelSlot(): HTMLDivElement {
  const slot = container.querySelector<HTMLDivElement>(".right-rail-panel-slot");
  expect(slot).not.toBeNull();
  return slot!;
}

function panelHeadReveal(): HTMLDivElement {
  const reveal = container.querySelector<HTMLDivElement>(".right-rail-panel-head-reveal");
  expect(reveal).not.toBeNull();
  return reveal!;
}

function dispatchSlotPointer(
  type: "pointermove" | "pointerdown" | "pointerleave",
  init: { readonly clientY: number; readonly pointerType?: string },
): void {
  const slot = panelSlot();
  vi.spyOn(slot, "getBoundingClientRect").mockReturnValue({
    x: 800,
    y: 100,
    top: 100,
    left: 800,
    right: 1160,
    bottom: 700,
    width: 360,
    height: 600,
    toJSON: () => ({}),
  });
  act(() => {
    slot.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 980,
      clientY: init.clientY,
      pointerType: init.pointerType ?? "mouse",
    }));
  });
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

describe("Right Rail icons for surface-opening actions", () => {
  // 셸은 패널이 아니라 확대 표면이라, 예전에는 rail 아이콘이 켜질 자리가 없었다(항상
  // isActive=false). 열려 있는데 아이콘이 꺼져 있으면 지금 어디에 서 있는지 알 수 없다.
  it("lights the icon while its surface holds a slot", () => {
    renderRail("theater-a");
    expect(actionIcon("SHELL").classList.contains("is-active")).toBe(false);

    act(() => { openExpandedSurface({ surfaceId: "shell" }); });

    expect(actionIcon("SHELL").classList.contains("is-active")).toBe(true);
  });

  it("puts the icon out again when the surface closes", () => {
    renderRail("theater-a");
    act(() => { openExpandedSurface({ surfaceId: "shell" }); });
    expect(actionIcon("SHELL").classList.contains("is-active")).toBe(true);

    act(() => { closeExpandedSurfacesOf("shell"); });

    expect(actionIcon("SHELL").classList.contains("is-active")).toBe(false);
  });

  // 탭이 아니라 토글 버튼이므로 켜짐은 pressed로 말한다.
  it("says pressed rather than selected", () => {
    renderRail("theater-a");
    act(() => { openExpandedSurface({ surfaceId: "shell" }); });

    const icon = actionIcon("SHELL");
    expect(icon.getAttribute("aria-pressed")).toBe("true");
    expect(icon.getAttribute("aria-selected")).toBeNull();
  });

  it("leaves an action that opens no surface unlit", () => {
    renderRail("theater-a");

    act(() => { openExpandedSurface({ surfaceId: "shell" }); });

    expect(actionIcon("PLAIN").classList.contains("is-active")).toBe(false);
    expect(actionIcon("PLAIN").getAttribute("aria-pressed")).toBeNull();
  });

  it("ignores a different surface standing in a slot", () => {
    renderRail("theater-a");

    act(() => { openExpandedSurface({ surfaceId: "codex" }); });

    expect(actionIcon("SHELL").classList.contains("is-active")).toBe(false);
  });
});

function actionIcon(label: string): HTMLButtonElement {
  const icon = container.querySelector<HTMLButtonElement>(`.right-rail-ico[aria-label="${label}"]`);
  expect(icon, `no rail icon labelled ${label}`).not.toBeNull();
  return icon!;
}
