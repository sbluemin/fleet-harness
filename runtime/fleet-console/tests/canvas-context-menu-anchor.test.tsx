// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationCatalogPlugin } from "@fleet-console/sdk/operations";

import {
  CanvasContextMenu,
  OPERATION_LAUNCH_EFFORT_MENU_WIDTH,
} from "../core/client/src/canvas/canvas-context-menu.js";
import {
  FEATURE_TOUR_BOUNDARY_ATTRIBUTE,
  FEATURE_TOUR_LAYER_ATTRIBUTE,
} from "../core/client/src/feature-tour-catalog.js";
import { EFFORT_CONFIRM_TIP_SEEN_KEY } from "../core/client/src/components/feature-tour.js";
import { getGlobalSettingsStoreState, hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import type { GlobalSettingsState } from "../core/client/src/types.js";

const SETTINGS: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  remoteAccess: { enabled: false, publicEndpointEnabled: false, listenAddress: "", advertisedHost: "", listenPort: { mode: "auto", value: 49152 }, advertisedPort: { mode: "auto", value: 49153 }, acknowledgment: null },
  language: "auto",
  seenFeatureTours: [],
  theme: "instrument",
  uiFont: { source: "builtin", id: "manrope", size: 14 },
};

let container: HTMLDivElement;
let root: Root;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
let tourLayer: HTMLDivElement | null;
const originalFetch = globalThis.fetch;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    if (this.classList.contains("canvas-context-menu")) {
      return { ...originalGetBoundingClientRect.call(this), width: 264, height: 133 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  tourLayer = null;
  hydrateGlobalSettings(SETTINGS);
  globalThis.fetch = vi.fn(async (_input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Partial<GlobalSettingsState> : {};
    const previous = getGlobalSettingsStoreState().state ?? SETTINGS;
    return new Response(JSON.stringify({
      state: {
        ...previous,
        ...body,
        seenFeatureTours: body.seenFeatureTours ?? previous.seenFeatureTours,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  tourLayer?.remove();
  container.remove();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  globalThis.fetch = originalFetch;
  hydrateGlobalSettings(SETTINGS);
});

describe("CanvasContextMenu anchor placement", () => {
  it("keeps the menu at the cursor when there is enough room below", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 });

    const style = menuStyle();
    expect(style.left).toBe("520px");
    expect(style.top).toBe("156px");
    expect(style.getPropertyValue("--canvas-menu-max-height")).toBe("520px");
  });

  it("flips the menu above the cursor using its rendered height", () => {
    renderMenu({ x: 520, y: 756 }, { width: 1116, height: 856 });

    const style = menuStyle();
    expect(style.top).toBe("623px");
    expect(style.top).not.toBe("324px");
  });

  it("clamps the menu horizontally using its rendered width", () => {
    renderMenu({ x: 1000, y: 156 }, { width: 1116, height: 856 });

    expect(menuStyle().left).toBe("840px");
  });

  it("derives the menu max-height from a short viewport", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 400 });

    expect(menuStyle().getPropertyValue("--canvas-menu-max-height")).toBe("376px");
  });

  // 이 포커스는 높이 측정 전 좌표에서 발화한다 — 커서를 그대로 쓴 첫 렌더라 하단에서 열면 메뉴가
  // 캔버스 밖으로 넘친다. 그 찰나의 위치로 조상을 굴리게 두면 판이 밀린 채 남으므로, 여는 포커스는
  // 스크롤을 요구하지 않아야 한다.
  it("takes the opening focus without asking any ancestor to scroll", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      renderMenu({ x: 520, y: 756 }, { width: 1116, height: 856 });

      const menuFocus = focus.mock.calls.filter((_call, index) =>
        (focus.mock.instances[index] as HTMLElement).classList.contains("canvas-context-menu"));
      expect(menuFocus).toHaveLength(1);
      expect(menuFocus[0]![0]).toEqual({ preventScroll: true });
    } finally {
      focus.mockRestore();
    }
  });

  it("renders fixed at viewport coordinates when the fixed prop is set", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], vi.fn(), true);

    const style = menuStyle();
    expect(style.position).toBe("fixed");
    expect(style.left).toBe("520px");
    expect(style.top).toBe("156px");
  });
});

describe("CanvasContextMenu launch kind attribute", () => {
  it("tags each launch item with its kind id so selectors do not depend on the title", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude", type: "agent", title: "Claude" },
        ],
      },
    ]);

    const gateway = document.querySelectorAll<HTMLButtonElement>('[data-operation-launch-kind="claude"]');
    expect(gateway).toHaveLength(1);
    expect(gateway[0]?.textContent).toContain("Claude");
  });

  it("annotates the Claude launch kinds with a description and no extra decoration", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "codex", type: "agent", title: "Codex" },
          { id: "claude", type: "agent", title: "Claude" },
        ],
      },
    ]);

    const descriptionOf = (kindId: string) =>
      document.querySelector(`[data-operation-launch-kind="${kindId}"] .operation-launch-menu-description`)?.textContent;

    expect(descriptionOf("claude")).toContain("built-in Claude and enabled Gateway models");
    // 설명은 Claude Gateway에만 붙는다 — 대비가 필요 없는 종류까지 늘리면 메뉴만 길어진다.
    expect(descriptionOf("codex")).toBeUndefined();
    expect(descriptionOf("shell")).toBeUndefined();

    // 종류 구분은 라벨 괄호 안이 들고 있다 — 항목에 별도 표식을 덧붙이지 않는다.
    expect(document.querySelector(".operation-launch-menu-badge")).toBeNull();
    expect(document.querySelector('[data-operation-launch-kind="claude"]')?.textContent)
      .toContain("Claude");
  });

  it("shows the disabled reason instead of the description when the CLI cannot launch", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude", type: "agent", title: "Claude", disabled: true, disabledReason: "Not installed" },
        ],
      },
    ]);

    const item = document.querySelector('[data-operation-launch-kind="claude"]');
    expect(item?.querySelector(".operation-launch-menu-reason")?.textContent).toBe("Not installed");
    expect(item?.querySelector(".operation-launch-menu-description")).toBeNull();
  });

  it("omits role and plugin chrome", () => {
    const terminal: OperationCatalogPlugin = {
      id: "terminal",
      title: "Terminal",
      kinds: [
        { id: "codex", type: "agent", title: "Codex" },
      ],
    };
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [terminal]);

    expect(document.querySelector(".canvas-context-menu-head")).toBeNull();
    expect(document.querySelector(".canvas-context-menu")?.textContent).not.toContain("Controls");
    expect(document.querySelector(".canvas-context-menu")?.textContent).not.toContain("Terminal");
    expect(document.querySelector(".operation-launch-variant-caption")).toBeNull();
    expect(document.querySelector(".operation-launch-provider-glyph--etc")).toBeNull();

    const order = Array.from(document.querySelectorAll("[data-operation-launch-kind]"))
      .map((node) => node.getAttribute("data-operation-launch-kind"));
    expect(order).toEqual(["codex"]);
    expect(document.querySelectorAll(".theater-menu-divider")).toHaveLength(0);
  });

  it("keeps the kind contrast on the row and opens the full description only for the pointed kind", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude", type: "agent", title: "Claude" },
        ],
      },
    ]);

    // 짧은 대비는 늘 행 위에 있다 — 터치와 정적 스캔에서도 종류가 갈려야 한다.
    const briefs = Array.from(document.querySelectorAll(".operation-launch-menu-brief")).map((node) => node.textContent);
    expect(briefs).toEqual(["Built-in + Gateway"]);

    // 설명 문장은 짚기 전에는 옆에 펴지지 않지만, 버튼 안에는 남아 접근 이름에 실린다.
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();
    const gateway = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude"]')!;
    expect(gateway.textContent).toContain("Runs Claude Code with built-in Claude and enabled Gateway models");

    act(() => gateway.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")?.textContent)
      .toBe("Runs Claude Code with built-in Claude and enabled Gateway models");

    // 어사이드는 메뉴 상자 바깥 형제다 — 안에 두면 메뉴의 overflow가 잘라낸다.
    expect(document.querySelector(".canvas-context-menu")?.contains(document.querySelector(".canvas-context-menu-aside"))).toBe(false);
  });

  it("enters the list on the first arrow key and cycles past kinds that cannot launch", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude", type: "agent", title: "Claude" },
          { id: "codex", type: "agent", title: "Codex", disabled: true, disabledReason: "Not installed" },
        ],
      },
    ]);

    const menu = document.querySelector<HTMLElement>(".canvas-context-menu")!;
    const activeKind = () => (document.activeElement as HTMLElement | null)?.dataset.operationLaunchKind;

    // 열자마자 아무것도 고르지 않는다 — 이미 선택된 듯 보이면 잘못 누르게 된다.
    expect(document.activeElement).toBe(menu);

    act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(activeKind()).toBe("claude");

    // 실행할 수 없는 종류와 우클릭에서 제거된 Shell을 건너뛰고 처음으로 돈다.
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(activeKind()).toBe("claude");

    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(activeKind()).toBe("claude");
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(activeKind()).toBe("claude");
  });

  it("places the description aside on the side that has room and withholds it when neither does", () => {
    const catalog: readonly OperationCatalogPlugin[] = [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "claude", type: "agent", title: "Claude" }],
      },
    ];
    const point = () => act(() =>
      document.querySelector('[data-operation-launch-kind="claude"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));

    // 오른쪽에 자리가 있으면 오른쪽.
    renderMenu({ x: 100, y: 156 }, { width: 1116, height: 856 }, catalog);
    point();
    expect(document.querySelector(".canvas-context-menu-aside")?.className).not.toContain("--flip");

    // 오른쪽이 막히고 왼쪽이 열려 있으면 뒤집는다.
    renderMenu({ x: 1000, y: 156 }, { width: 1116, height: 856 }, catalog);
    point();
    expect(document.querySelector(".canvas-context-menu-aside")?.className).toContain("--flip");

    // 양쪽 모두 좁으면 아예 펴지 않는다 — 뒤집기만 하면 설명이 화면 왼쪽으로 밀려 잘린다.
    renderMenu({ x: 200, y: 156 }, { width: 400, height: 800 }, catalog);
    point();
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();
    // 펴지 못해도 대비와 설명 문장 자체는 행에 남는다.
    const row = document.querySelector('[data-operation-launch-kind="claude"]')!;
    expect(row.querySelector(".operation-launch-menu-brief")?.textContent).toBe("Built-in + Gateway");
    expect(row.textContent).toContain("built-in Claude and enabled Gateway models");
  });

  it("keys the open description by plugin so two plugins may share a kind id", () => {
    renderMenu({ x: 100, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "shared-agent", type: "agent", title: "Local Agent" }],
      },
      {
        id: "remote",
        title: "Remote",
        kinds: [{ id: "shared-agent", type: "agent", title: "Remote Agent" }],
      },
    ]);

    const rows = document.querySelectorAll<HTMLButtonElement>(".canvas-context-menu-item");
    expect(rows).toHaveLength(2);
    act(() => rows[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();
    act(() => rows[0]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();
  });

  it("closes when focus leaves the menu, since its items sit outside the tab order", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "codex", type: "agent", title: "Codex" }],
      },
    ], onClose);

    const outside = document.createElement("button");
    document.body.append(outside);
    const menu = document.querySelector<HTMLElement>(".canvas-context-menu")!;

    // 메뉴 안에서 옮겨 다니는 동안에는 닫지 않는다.
    act(() => menu.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: menu.querySelector(".canvas-context-menu-item") })));
    expect(onClose).not.toHaveBeenCalled();

    act(() => menu.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside })));
    expect(onClose).toHaveBeenCalledOnce();
    outside.remove();
  });

  it("stays open while the feature tour card takes focus from one of its anchored items", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "claude", type: "agent", title: "Claude" }],
      },
    ], onClose);
    tourLayer = document.createElement("div");
    tourLayer.setAttribute(FEATURE_TOUR_LAYER_ATTRIBUTE, "");
    const tourNext = document.createElement("button");
    tourLayer.append(tourNext);
    document.body.append(tourLayer);

    const menu = document.querySelector<HTMLElement>(".canvas-context-menu")!;
    // 투어는 이 메뉴의 항목마다 앵커를 걸고 여러 단계를 걷는다 — 다음 단계 버튼을 눌렀다고
    // 메뉴가 닫히면 남은 단계가 짚을 대상이 사라진다.
    act(() => menu.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: tourNext })));
    expect(onClose).not.toHaveBeenCalled();

    const outside = document.createElement("button");
    document.body.append(outside);
    act(() => menu.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside })));
    expect(onClose).toHaveBeenCalledOnce();
    outside.remove();
  });

  it("keeps the focused item's description when the pointer leaves the menu", () => {
    renderMenu({ x: 100, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude", type: "agent", title: "Claude" },
        ],
      },
    ]);

    const menu = document.querySelector<HTMLElement>(".canvas-context-menu")!;
    const rows = document.querySelectorAll<HTMLButtonElement>(".canvas-context-menu-item");
    const asideText = () => document.querySelector(".canvas-context-menu-aside")?.textContent;

    expect(rows).toHaveLength(1);
    // Shell은 rail 실행으로 이동했으므로 우클릭 메뉴에는 Claude 행만 남는다.
    act(() => rows[0]!.focus());
    expect(asideText()).toBe("Runs Claude Code with built-in Claude and enabled Gateway models");

    act(() => menu.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    expect(asideText()).toBe("Runs Claude Code with built-in Claude and enabled Gateway models");
  });

  it("keeps a concise accessible name without rendering a visual header", () => {
    act(() => root.render(
      <CanvasContextMenu
        anchor={{ x: 520, y: 156 }}
        viewportBounds={{ width: 1116, height: 856 }}
        catalog={[{ id: "terminal", title: "Terminal", kinds: [{ id: "codex", type: "agent", title: "Codex" }] }]}
        canLaunch
        renderKindIcon={() => null}
        onLaunchKind={vi.fn()}
        onClose={vi.fn()}
      />,
    ));

    const menu = document.querySelector(".canvas-context-menu")!;
    expect(menu.getAttribute("aria-label")).toBe("Operation launcher");
    expect(document.querySelector(".canvas-context-menu-head")).toBeNull();
    expect(document.querySelector(".operation-launch-provider-glyph--etc")).toBeNull();
  });

  it("gives the menu a valid ancestor for its menu items", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "codex", type: "agent", title: "Codex" }],
      },
    ]);

    const menu = document.querySelector(".canvas-context-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      expect(item.closest('[role="menu"]')).toBe(menu);
    }
  });

  it("lists the models directly in the menu, keeps direct-launch kinds above the bands, and preserves every payload", () => {
    const onLaunchKind = vi.fn();
    const catalog = gatewayVariantCatalog();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, catalog, vi.fn(), false, onLaunchKind);

    // 실행 종류를 짚어 여는 단이 사라졌다 — 모델 밴드가 메뉴의 첫 단이다.
    expect(document.querySelector(".operation-launch-flyout")).toBeNull();
    expect(document.querySelector(".operation-launch-variant-caption")?.textContent).toBe("Claude");
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();

    const row = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;
    // 모델 행도 결국 이 실행 종류를 띄운다 — 종류를 짚는 바깥 선택자가 밴드에서도 닿아야 한다.
    expect(row.getAttribute("data-operation-launch-kind")).toBe("claude");
    // 펼쳐지는 것은 메뉴가 아니라 슬라이더 하나짜리 상자다 — haspopup=menu로 예고하면 보조기술이
    // 메뉴 탐색 모델을 씌워 트랙을 조작 대상으로 보지 않는다.
    expect(row.hasAttribute("aria-haspopup")).toBe(false);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".effort-track")).toBeNull();

    // 강도를 건드리지 않은 행은 모델만 싣는다.
    act(() => row.click());
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0], { model: "fable" });

    // 행 본문을 지나는 것만으로는 강도 상자가 열리지 않는다 — 목록을 훑는 동작이 매번
    // 캐스케이드를 여는 동작이 되면 모델을 고르는 일이 그 상자를 피해 다니는 일이 된다.
    act(() => row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(document.querySelector(".effort-track")).toBeNull();

    // End는 단만 고른다. 같은 단을 다시 확정(Enter)하면 그 강도로 출격한다.
    act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const track = document.querySelector<HTMLElement>(".effort-track")!;
    expect(track).not.toBeNull();
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onLaunchKind).toHaveBeenCalledTimes(1);
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(onLaunchKind).toHaveBeenCalledTimes(1);
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onLaunchKind).toHaveBeenCalledTimes(2);
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0], { model: "fable", effort: "max" });

    // 고른 강도는 행에도 되비치고, 그 행을 눌러도 같은 페이로드로 실행된다.
    expect(effortHandle("fable").querySelector(".operation-launch-variant-effort")?.textContent).toBe("MAX");
    expect(effortHandle("fable").dataset.effortLevel).toBe("max");
    act(() => document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!.click());
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0], { model: "fable", effort: "max" });
  });

  it("launches a MAX-less gateway row's ultra chip with the ultra effort payload", () => {
    // max를 내지 않는 gateway 모델도 마지막 칩은 ULTRACODE다 — 게이트를 열어 End로 골라
    // 확정하면 칩이 실은 그대로 { model, effort: "ultra" }로 출격한다.
    const onLaunchKind = vi.fn();
    const catalog: readonly OperationCatalogPlugin[] = [{
      id: "terminal",
      title: "Terminal",
      kinds: [{
        id: "claude",
        type: "agent",
        title: "Claude",
        variants: [{
          id: "gateway:cursor",
          label: "Cursor",
          rows: [{
            id: "cursor--grok-4.6-fast",
            label: "Grok-4.6-Fast",
            launch: { model: "cursor--grok-4.6-fast" },
            effortAxis: ["low", "medium", "high", "xhigh", "ultra"],
            gatedEfforts: ["ultra"],
            chips: [
              { id: "low", label: "LOW", launch: { model: "cursor--grok-4.6-fast", effort: "low" } },
              { id: "ultra", label: "ULTRACODE", launch: { model: "cursor--grok-4.6-fast", effort: "ultra" } },
            ],
          }],
        }],
      }],
    }];
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, catalog, vi.fn(), false, onLaunchKind);

    act(() => effortHandle("cursor--grok-4.6-fast").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const track = document.querySelector<HTMLElement>(".effort-track")!;
    // 닫힌 트랙의 End는 일상 마지막 단(low)에 선다 — ultra는 게이트 뒤다.
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0], { model: "cursor--grok-4.6-fast", effort: "low" });

    act(() => document.querySelector<HTMLButtonElement>(".effort-track-apex-toggle")!.click());
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(effortHandle("cursor--grok-4.6-fast").dataset.effortLevel).toBe("ultra");
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0], { model: "cursor--grok-4.6-fast", effort: "ultra" });
  });

  it("drops the description aside when the pointer reaches a model row, even while focus sits on an annotated row", () => {
    // 두 채널을 합치는 `hoverKey ?? focusKey`는 포인터 쪽을 비우면 포커스가 짚던 행으로 되돌아간다.
    // 모델 행은 자기 키로 덮어야 "설명 없는 자리"가 되고, 포인터가 메뉴를 벗어나면 다시 포커스가 드러난다.
    const [gateway] = gatewayVariantCatalog();
    renderMenu({ x: 320, y: 156 }, { width: 1400, height: 856 }, [
      { id: "terminal", title: "Terminal", kinds: [{ id: "claude", type: "agent", title: "Claude" }] },
      { ...gateway!, id: "models", title: "Models" },
    ]);

    const annotated = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude"]')!;
    act(() => annotated.focus());
    expect(document.querySelector(".canvas-context-menu-aside")).not.toBeNull();

    const entry = document.querySelector<HTMLElement>(".operation-launch-variant-entry")!;
    act(() => entry.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();

    // 포인터가 메뉴를 떠나면 포커스가 짚던 설명이 다시 드러난다.
    act(() => document.querySelector(".canvas-context-menu")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")).not.toBeNull();
  });

  it("preserves model bands", () => {
    const [gateway] = gatewayVariantCatalog();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [{
      ...gateway!,
      kinds: [...gateway!.kinds],
    }]);

    const order = Array.from(document
      .querySelector(".canvas-context-menu")!
      .querySelectorAll('.operation-launch-variant-caption, [data-launch-variant-row]'))
      .map((element) => element.getAttribute("data-launch-variant-row")
        ?? `caption:${element.textContent?.trim()}`);
    expect(order).toEqual(["caption:Claude", "fable"]);
  });

  it("keeps a locked menu on one direct row per kind instead of an unusable model band", () => {
    // canLaunch=false는 Theater가 없거나 추가 중인 상태다. 밴드를 펴면 고를 수 없는 모델이
    // 열두 줄 서고, 방향키 집합은 그 전부를 걸러 내 아무 항목도 남지 않는다.
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog(), vi.fn(), false, vi.fn(), false);

    expect(document.querySelector(".operation-launch-variant-caption")).toBeNull();
    expect(document.querySelector("[data-launch-variant-row]")).toBeNull();
    const locked = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude"]')!;
    expect(locked.disabled).toBe(true);
  });

  it("expands a disabled variant kind as its own reason row instead of an unusable model band", () => {
    const [gateway] = gatewayVariantCatalog();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [{
      ...gateway!,
      kinds: [{ ...gateway!.kinds[0]!, disabled: true, disabledReason: "Not installed" }],
    }]);

    expect(document.querySelector(".operation-launch-variant-caption")).toBeNull();
    expect(document.querySelector("[data-launch-variant-row]")).toBeNull();
    const row = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude"]')!;
    expect(row.disabled).toBe(true);
    expect(row.querySelector(".operation-launch-menu-reason")?.textContent).toBe("Not installed");
  });

  it("says on the row what the effort handle opens, and opens it without launching", () => {
    const onLaunchKind = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog(), vi.fn(), false, onLaunchKind);

    const handle = effortHandle("fable");
    // 꺾쇠 하나로는 무엇이 열리는지 말하지 못한다 — 계기 표식과 지금 실린 단이 함께 선다.
    expect(handle.getAttribute("title")).toBe("Reasoning effort");
    expect(handle.dataset.effortLevel).toBe("auto");
    expect(handle.querySelector(".operation-launch-variant-effort")?.textContent).toBe("AUTO");
    // 계기는 이 행의 사다리를 그대로 줄인다 — 이 행은 high·max 두 단만 내놓는다.
    const bars = handle.querySelectorAll(".operation-launch-variant-effort-gauge rect");
    expect(bars).toHaveLength(2);
    // 자동은 한 칸도 켜지지 않는다 — 최소 단을 고른 것과 갈려야 한다.
    expect(Array.from(bars).filter((bar) => bar.getAttribute("data-lit") === "true")).toHaveLength(0);

    // 손잡이를 눌러도 출격하지 않는다. 강도를 고르려던 클릭이 실행이 되면 되돌릴 수 없다.
    act(() => handle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onLaunchKind).not.toHaveBeenCalled();
    expect(document.querySelector(".effort-track")).not.toBeNull();
    expect(effortHandle("fable").dataset.open).toBe("true");

    act(() => document.querySelector<HTMLElement>(".effort-track")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    // 고른 단까지 계기가 차오른다 — max는 이 사다리의 끝이라 두 칸 전부다.
    const lit = effortHandle("fable").querySelectorAll('.operation-launch-variant-effort-gauge rect[data-lit="true"]');
    expect(lit).toHaveLength(2);
    expect(effortHandle("fable").dataset.effortLevel).toBe("max");
  });

  it("clamps the effort submenu inside narrow horizontal bounds", () => {
    const bounds = { width: 500, height: 360 };
    renderMenu({ x: 450, y: 320 }, bounds, gatewayVariantCatalog());

    act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const effort = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;
    const left = Number.parseFloat(effort.style.left);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left).toBeLessThanOrEqual(bounds.width - OPERATION_LAUNCH_EFFORT_MENU_WIDTH - 12);
    expect(Number.parseFloat(effort.style.top)).toBeGreaterThanOrEqual(12);
  });

  it("opens the effort submenu to the right instead of folding onto the menu when both sides fit", () => {
    // 캔버스 왼쪽에서 연 메뉴는 서브메뉴가 오른쪽으로 열린다. "왼쪽 여유가 더 넓다"는 이유로
    // 접히면 메뉴 위에 겹쳐, 짚은 행과 무관한 자리에 뜬 상자가 된다.
    const bounds = { width: 1280, height: 800 };
    renderMenu({ x: 260, y: 100 }, bounds, gatewayVariantCatalog());

    act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const effort = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;
    expect(effort.classList.contains("is-left")).toBe(false);
    // 서브메뉴는 메뉴 상자의 오른쪽 바깥에 선다 — 부모 위로 되돌아오지 않는다.
    expect(Number.parseFloat(effort.style.left)).toBeGreaterThanOrEqual(260 + 264);
  });

  it("follows the model row while the menu scrolls, and lets go once the row leaves it", () => {
    // 서브메뉴는 fixed라 목록이 굴러도 제자리에 남는다. 짚고 있던 행이 올라가 버리면 그 상자는
    // 엉뚱한 행 옆에서 그 행의 강도인 척하고, 행을 눌러 실행하는 표면에서는 그대로 오실행이 된다.
    // 목록이 메뉴 자체가 되었으므로 굴러가는 상자도 메뉴다.
    const menuRect = { top: 100, bottom: 400, left: 0, right: 264, width: 264, height: 300 };
    let anchorRect = { top: 150, bottom: 178, left: 8, right: 208, width: 200, height: 28 };
    const previous = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this.classList.contains("canvas-context-menu")) return { ...menuRect, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
      if (this.classList.contains("operation-launch-variant-entry")) return { ...anchorRect, x: 8, y: anchorRect.top, toJSON: () => ({}) } as DOMRect;
      return previous.call(this);
    };
    try {
      renderMenu({ x: 200, y: 100 }, { width: 1280, height: 420 }, gatewayVariantCatalog());
      act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
      const topAfterOpen = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!.style.top;

      // 행이 아직 메뉴 안에 있으면 따라간다.
      anchorRect = { ...anchorRect, top: 120, bottom: 148 };
      act(() => document.querySelector(".canvas-context-menu")!.dispatchEvent(new Event("scroll")));
      const menu = document.querySelector<HTMLElement>(".operation-launch-effort-menu");
      expect(menu).not.toBeNull();
      expect(menu!.style.top).not.toBe(topAfterOpen);

      // 행이 메뉴 위로 사라지면 "그 행의 강도"라는 관계가 끊긴다 — 따라가지 않고 닫는다.
      anchorRect = { ...anchorRect, top: 40, bottom: 68 };
      act(() => document.querySelector(".canvas-context-menu")!.dispatchEvent(new Event("scroll")));
      expect(document.querySelector(".operation-launch-effort-menu")).toBeNull();
    } finally {
      Element.prototype.getBoundingClientRect = previous;
    }
  });

  it("clamps the effort submenu inside short vertical bounds", () => {
    const bounds = { width: 1116, height: 160 };
    const effortHeight = 148;
    const effortWidth = 104;
    const previousGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this.classList.contains("operation-launch-effort-menu")) {
        return {
          x: 0, y: 0, left: 0, top: 0, width: effortWidth, height: effortHeight,
          right: effortWidth, bottom: effortHeight, toJSON: () => ({}),
        };
      }
      return previousGetBoundingClientRect.call(this);
    };
    try {
      renderMenu({ x: 520, y: 120 }, bounds, gatewayVariantCatalog());
      act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

      const effort = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;
      // maxTop = max(12, 160 - 148 - 12) = 12 — anything taller must land on the margin.
      expect(Number.parseFloat(effort.style.top)).toBe(12);
    } finally {
      Element.prototype.getBoundingClientRect = previousGetBoundingClientRect;
    }
  });

  it("keeps model rows in the arrow-key set", () => {
    const [gateway] = gatewayVariantCatalog();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [{
      ...gateway!,
      kinds: [...gateway!.kinds],
    }]);

    const menu = document.querySelector<HTMLElement>(".canvas-context-menu")!;
    const model = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;

    act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(model);
    pressFlyoutKey("ArrowDown");
    expect(document.activeElement).toBe(model);
  });

  it("opens the effort submenu from a model row with ArrowRight, then restores focus with Escape", async () => {
    renderMenu({ x: 900, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog());
    const row = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;

    act(() => {
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const track = document.querySelector<HTMLElement>(".effort-track")!;
    const popup = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;
    expect(popup).not.toBeNull();
    // 서브메뉴는 메뉴의 스크롤 상자 바깥 형제라 목록에 잘리지 않는다.
    expect(popup.parentElement).toBe(document.querySelector(".operation-launch-control--canvas"));
    expect(popup.closest(".canvas-context-menu")).toBeNull();
    // 상자는 그룹이고, 그것을 연 행이 aria-controls로 가리킨다.
    expect(popup.getAttribute("role")).toBe("group");
    expect(row.getAttribute("aria-controls")).toBe(popup.id);
    expect(document.activeElement).toBe(track);

    // 트랙 위에서 방향키는 값을 옮긴다 — 실행은 여전히 모델 행이 일으킨다.
    pressFlyoutKey("End");
    expect(document.querySelector(".operation-launch-variant-effort")?.textContent).toBe("MAX");

    // 그래서 서브메뉴에서 나오는 키는 방향키가 아니라 Escape다.
    pressFlyoutKey("Escape");
    expect(document.querySelector(".operation-launch-effort-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("closes only the effort submenu on Escape", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog(), onClose);
    const row = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;
    act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const popup = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;

    act(() => popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(document.querySelector(".operation-launch-effort-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves non-Shell kinds without variants on the direct-launch path", () => {
    const onLaunchKind = vi.fn();
    const catalog: readonly OperationCatalogPlugin[] = [{
      id: "tools",
      title: "Tools",
      kinds: [{ id: "notes", type: "notes", title: "Notes" }],
    }];
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, catalog, vi.fn(), false, onLaunchKind);

    const notes = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="notes"]')!;
    expect(notes.hasAttribute("aria-haspopup")).toBe(false);
    expect(notes.querySelector(".operation-launch-menu-chevron")).toBeNull();
    act(() => notes.click());
    expect(onLaunchKind).toHaveBeenCalledWith("tools", catalog[0]!.kinds[0]);
  });

  it("marks the rendered menu box as the tour placement boundary", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 });

    const boundary = document.querySelector(`[${FEATURE_TOUR_BOUNDARY_ATTRIBUTE}]`);
    expect(boundary).toBe(document.querySelector(".canvas-context-menu"));
    expect(boundary).not.toBe(document.querySelector(".operation-launch-control"));
  });

  it("focuses the menu container and dismisses it with Escape", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], onClose);

    expect(document.activeElement).toBe(document.querySelector(".canvas-context-menu"));
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses the menu on the shared close signal emitted by cross-surface interactions", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], onClose);

    act(() => window.dispatchEvent(new Event("canvas-context-menu-close")));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not dismiss the menu before the feature tour card handles its click", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], onClose);
    tourLayer = document.createElement("div");
    tourLayer.setAttribute(FEATURE_TOUR_LAYER_ATTRIBUTE, "");
    const tourButton = document.createElement("button");
    tourLayer.append(tourButton);
    document.body.append(tourLayer);

    act(() => tourButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();

    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("CanvasContextMenu effort confirm tip", () => {
  it("keeps showing the tip on non-AUTO selection until the confirm gesture graduates it", async () => {
    const onLaunchKind = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog(), vi.fn(), false, onLaunchKind);
    act(() => document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude"]')!
      .parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const track = document.querySelector<HTMLElement>(".effort-track")!;
    expect(document.querySelector(".operation-launch-effort-confirm-tip")).toBeNull();

    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    const tip = document.querySelector<HTMLElement>(".operation-launch-effort-confirm-tip");
    expect(tip?.textContent).toBe("Press the knob again to launch.");
    expect(tip?.getAttribute("role")).toBe("status");
    // 선택만으로는 졸업하지 않는다 — 피처 투어를 건너뛰고 메뉴를 닫아도 다음에 다시 보인다.
    expect(fetch).not.toHaveBeenCalled();
    expect(getGlobalSettingsStoreState().state?.seenFeatureTours ?? []).not.toContain(EFFORT_CONFIRM_TIP_SEEN_KEY);

    await act(async () => {
      track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onLaunchKind).toHaveBeenCalledWith("terminal", gatewayVariantCatalog()[0]!.kinds[0], {
      model: "fable",
      effort: "max",
    });
    expect(fetch).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ seenFeatureTours: [EFFORT_CONFIRM_TIP_SEEN_KEY] }),
    }));
    expect(getGlobalSettingsStoreState().state?.seenFeatureTours).toContain(EFFORT_CONFIRM_TIP_SEEN_KEY);
  });

  it("keeps AUTO quiet and skips the tip when the confirm gesture was already seen", () => {
    hydrateGlobalSettings({ ...SETTINGS, seenFeatureTours: [EFFORT_CONFIRM_TIP_SEEN_KEY] });
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog());
    act(() => document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude"]')!
      .parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const track = document.querySelector<HTMLElement>(".effort-track")!;
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(document.querySelector(".operation-launch-effort-confirm-tip")).toBeNull();

    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.querySelector(".operation-launch-effort-confirm-tip")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("CanvasContextMenu edge strips", () => {
  // jsdom은 레이아웃이 없어 scrollHeight/clientHeight가 0이다 — 오버플로를 인스턴스 속성으로 흉내 낸다.
  function mockOverflow(menu: Element, { scrollHeight, clientHeight }: { readonly scrollHeight: number; readonly clientHeight: number }): void {
    Object.defineProperty(menu, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(menu, "clientHeight", { value: clientHeight, configurable: true });
  }
  const stripOn = (side: "top" | "bottom"): boolean =>
    document.querySelector(`.canvas-context-menu-edge--${side}`)!.classList.contains("is-on");

  it("raises only the strip pointing at hidden content", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog());
    const menu = document.querySelector(".canvas-context-menu")!;
    mockOverflow(menu, { scrollHeight: 640, clientHeight: 320 });

    menu.scrollTop = 0;
    act(() => { menu.dispatchEvent(new Event("scroll")); });
    expect(stripOn("top")).toBe(false);
    expect(stripOn("bottom")).toBe(true);

    menu.scrollTop = 160;
    act(() => { menu.dispatchEvent(new Event("scroll")); });
    expect(stripOn("top")).toBe(true);
    expect(stripOn("bottom")).toBe(true);

    menu.scrollTop = 320;
    act(() => { menu.dispatchEvent(new Event("scroll")); });
    expect(stripOn("top")).toBe(true);
    expect(stripOn("bottom")).toBe(false);
  });

  it("keeps both strips down when the list fits", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog());
    const menu = document.querySelector(".canvas-context-menu")!;
    mockOverflow(menu, { scrollHeight: 320, clientHeight: 320 });

    act(() => { menu.dispatchEvent(new Event("scroll")); });
    expect(stripOn("top")).toBe(false);
    expect(stripOn("bottom")).toBe(false);
  });

  it("lights the scroll gauge while the list is scrolling", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog());
    const menu = document.querySelector(".canvas-context-menu")!;
    mockOverflow(menu, { scrollHeight: 640, clientHeight: 320 });

    const gauge = document.querySelector(".canvas-context-menu-gauge")!;
    expect(gauge.classList.contains("is-on")).toBe(false);

    menu.scrollTop = 160;
    act(() => { menu.dispatchEvent(new Event("scroll")); });
    expect(gauge.classList.contains("is-on")).toBe(true);
    const thumb = document.querySelector<HTMLElement>(".canvas-context-menu-gauge-thumb")!;
    expect(thumb.style.height).not.toBe("");
    expect(thumb.style.top).not.toBe("");
  });
});

function renderMenu(
  anchor: { readonly x: number; readonly y: number },
  viewportBounds: { readonly width: number; readonly height: number },
  catalog: readonly OperationCatalogPlugin[] = [],
  onClose = vi.fn(),
  fixed = false,
  onLaunchKind = vi.fn(),
  canLaunch = true,
): void {
  act(() => root.render(
    <CanvasContextMenu
      anchor={anchor}
      viewportBounds={viewportBounds}
      fixed={fixed}
      catalog={catalog}
      canLaunch={canLaunch}
      renderKindIcon={() => null}
      onLaunchKind={onLaunchKind}
      onClose={onClose}
    />,
  ));
}

function gatewayVariantCatalog(): readonly OperationCatalogPlugin[] {
  return [{
    id: "terminal",
    title: "Terminal",
    kinds: [{
      id: "claude",
      type: "agent",
      title: "Claude",
      variants: [{
        id: "native",
        label: "Claude",
        rows: [{
          id: "fable",
          label: "Fable",
          launch: { model: "fable" },
          chips: [
            {
              id: "high",
              label: "HIGH",
              launch: { model: "fable", effort: "high" },
            },
            {
              id: "max",
              label: "MAX",
              launch: { model: "fable", effort: "max" },
            },
          ],
        }],
      }],
    }],
  }];
}

/** 강도 상자를 여는 자리는 행이 아니라 행 오른쪽의 이 손잡이다. */
function effortHandle(rowId: string): HTMLElement {
  const entry = document.querySelector<HTMLElement>(`[data-launch-variant-row="${rowId}"]`)?.closest<HTMLElement>(".operation-launch-variant-entry");
  const handle = entry?.querySelector<HTMLElement>(".operation-launch-variant-effort-handle");
  if (!handle) throw new Error(`Missing the effort handle for ${rowId}`);
  return handle;
}

function pressFlyoutKey(key: string): void {
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

function menuStyle(): CSSStyleDeclaration {
  return document.querySelector<HTMLElement>(".operation-launch-control--canvas")!.style;
}
