// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const railPanelContextMock = vi.hoisted(() => ({ themes: [] as unknown[], renderCount: 0, activate: vi.fn() }));

const CORE_PANEL_FIXTURES = vi.hoisted(() => [] as Record<string, unknown>[]);
const BINDING_CACHE = vi.hoisted(() => ({ value: null as unknown }));
const PANE_INDEX_CACHE = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../core/client/src/rail/built-in-panels.js", () => ({
  BUILT_IN_RAIL_PANELS: CORE_PANEL_FIXTURES,
}));

const CORE_PANELS: Record<string, unknown>[] = [
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
];

// 새 계약의 레지스트리를 모킹한다. 여기 적는 것은 여전히 "옛 패널 모양"이고, 아래 helper가
// 그것을 엔트리+페인 바인딩으로 편다 — 프로덕션의 투영과 같은 규칙이라, 이 테스트는 투영 경로도
// 함께 지킨다.
function toBinding(panel: Record<string, unknown>) {
  const hasBody = typeof panel.render === "function";
  return {
    entry: {
      id: panel.id,
      title: panel.title,
      icon: panel.icon,
      ...(panel.surfaceId === undefined ? {} : { surfaceId: panel.surfaceId }),
      ...(hasBody ? { panes: [panel.id] } : { activate: panel.activate }),
    },
    panes: hasBody
      ? [{
        id: panel.id,
        role: "primary",
        mounts: ["rail"],
        title: () => panel.title,
        render: panel.render,
        ...(panel.defaultWidth === undefined ? {} : { defaultWidth: panel.defaultWidth }),
      }]
      : [],
    projected: true,
  };
}

// 프로덕션과 같은 자리의 코어 네이티브 설정 바인딩 — 톱니가 여는 표면이 실재해야
// "문이 표면을 연다"는 계약을 이 테스트가 지킬 수 있다.
function settingsBinding() {
  return {
    entry: { id: "settings", title: "SETTINGS", icon: "G", panes: ["settings"] },
    panes: [{ id: "settings", role: "primary", mounts: ["rail"], title: () => "SETTINGS", render: () => null, defaultWidth: 360 }],
    projected: false,
    core: true,
  };
}

function allBindings() {
  return [settingsBinding(), ...[...CORE_PANELS, ...LEGACY_PANEL_FIXTURES].map(toBinding)];
}

vi.mock("../core/client/src/pane/pane-registry.js", () => ({
  // 프로덕션 useRailEntries는 useMemo라 참조가 안정적이다. 매 호출 새 배열을 주면
  // RailSurface의 memo가 깨져 본문이 다시 렌더되므로, 여기서도 한 번만 만든다.
  useRailEntries: () => (BINDING_CACHE.value ??= allBindings()),
  // 표면이 마운트 라우팅과 형제 keepAlive를 이 색인으로 판단한다 — 같은 바인딩에서 파생시켜
  // 두 목록이 어긋나지 않게 한다.
  usePaneIndex: () => (PANE_INDEX_CACHE.value ??= new Map(
    (BINDING_CACHE.value ??= allBindings())
      .flatMap((binding: { panes: { id: string }[] }) => binding.panes.map((pane) => [pane.id, pane])),
  )),
}));

const LEGACY_PANEL_FIXTURES: Record<string, unknown>[] = [
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
];

import { RightRail } from "../core/client/src/rail/right-rail.js";
import {
  getRailStoreSnapshot,
  requestRailPanelExtraWidth,
  setActiveRailPanel,
  setRailChromeExpanded,
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
  setRailChromeExpanded(true);
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

/* 불투명도 컨트롤은 설정 페인(설정 > 겉모습)으로 이사했다 — 레일에 남은 계약은
   "스토어의 알파가 오버레이 슬롯에만 실린다"는 것이다. */
describe("Right Rail overlay opacity", () => {
  it("carries no alpha variable in push mode", () => {
    renderRail();

    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("");
  });

  it("follows the store alpha in overlay mode", () => {
    setRailPanelBehavior("overlay");
    renderRail();
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("1");

    act(() => setRailOverlayAlpha(65));

    expect(getRailStoreSnapshot().overlayAlpha).toBe(65);
    expect(window.localStorage.getItem("fleet-console.rail.overlayAlpha")).toBe("65");
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("0.65");
  });

  it("does not re-render the panel body while the alpha changes", () => {
    setRailPanelBehavior("overlay");
    renderRail();

    const renderCountBeforeChange = railPanelContextMock.renderCount;
    act(() => setRailOverlayAlpha(65));

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

/* 톱니는 메뉴가 아니라 설정 표면의 문이다 — 옛 컨텍스트 메뉴 계약(플로팅·불투명도·폭·닫기)은
   설정 페인과 직접 조작으로 해체됐고, 여기 남는 것은 문의 계약이다. */
describe("Right Rail settings gear", () => {
  it("puts the settings gear first in the icon column, split from the panel tabs by a divider", () => {
    renderRail();
    const column = container.querySelector<HTMLElement>(".right-rail-icons")!;
    const children = [...column.children];

    expect(children[0]).toBe(gearButton());
    expect(children[1]?.className).toBe("right-rail-divider");
    expect(children[1]?.getAttribute("role")).toBe("separator");
    // 디바이더 다음부터가 패널 탭이다 — 콘솔을 다스리는 일과 패널을 고르는 일의 경계.
    expect(children[2]?.className).toBe("right-rail-tabs");
  });

  it("carries no hover-reveal chrome, so the body owns the whole slot", () => {
    renderRail();

    expect(container.querySelector(".right-rail-panel-head-reveal")).toBeNull();
    expect(container.querySelector(".right-rail-panel-peek")).toBeNull();
    expect(panelSlot().querySelector(".right-rail-panel-body")).not.toBeNull();
  });

  it("toggles the settings surface and speaks its open state with pressed + brass", () => {
    renderRail();
    expect(gearButton().getAttribute("aria-pressed")).toBe("false");

    act(() => gearButton().click());

    expect(getRailStoreSnapshot().activeRailPanelId).toBe("settings");
    expect(gearButton().getAttribute("aria-pressed")).toBe("true");
    expect(gearButton().classList.contains("is-active")).toBe(true);
    // 문은 표면을 그대로 연다 — 설정 페인 본문이 패널 슬롯에 선다. 탭 없는 표면이므로
    // tabpanel이 아니라 문(토글)을 라벨로 삼는 region으로 서고, 문은 자기 표면을 가리킨다.
    const panel = container.querySelector("#rail-panel-settings")!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-labelledby")).toBe("rail-settings-toggle");
    expect(gearButton().id).toBe("rail-settings-toggle");
    expect(gearButton().getAttribute("aria-controls")).toBe("rail-panel-settings");

    act(() => gearButton().click());
    expect(getRailStoreSnapshot().activeRailPanelId).toBeNull();
    expect(gearButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the settings entry out of both panel tab lists", () => {
    renderRail();
    // 톱니가 곧 설정의 자리다 — 같은 표면을 여는 탭이 디바이더 아래 또 서면 문이 둘이 된다.
    expect(container.querySelector("#rail-tab-settings")).toBeNull();
    act(() => gearButton().click());
    expect(container.querySelector("#rail-tab-settings")).toBeNull();
  });

  it("resets a remembered panel width to the panel default on a divider double-click", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 520 }));
    renderRail();
    expect(renderedPanelWidth()).toBe(520);

    // 옛 메뉴의 "패널 폭 초기화"는 조작 대상 위의 직접 조작으로 왔다.
    act(() => resizeHandle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(renderedPanelWidth()).toBe(360);
    expect(window.localStorage.getItem("fleet-console.rail.panelWidths")).toBe("{}");
  });

  it("leaves no portaled rail menu behind", () => {
    renderRail();
    act(() => gearButton().click());

    // 메뉴는 해체됐다 — 문서에 포털된 팝업이 더는 서지 않는다.
    expect(document.body.querySelector(".right-rail-menu")).toBeNull();
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

function gearButton(): HTMLButtonElement {
  const gear = container.querySelector<HTMLButtonElement>(".right-rail-settings-btn");
  expect(gear).not.toBeNull();
  return gear!;
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
