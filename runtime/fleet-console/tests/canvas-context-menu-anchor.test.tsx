// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationCatalogPlugin } from "@fleet-console/sdk/operations";

import {
  CanvasContextMenu,
  OPERATION_LAUNCH_EFFORT_MENU_WIDTH,
  OPERATION_LAUNCH_FLYOUT_WIDTH,
} from "../core/client/src/canvas/canvas-context-menu.js";
import {
  FEATURE_TOUR_BOUNDARY_ATTRIBUTE,
  FEATURE_TOUR_LAYER_ATTRIBUTE,
} from "../core/client/src/feature-tour-catalog.js";

let container: HTMLDivElement;
let root: Root;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
let tourLayer: HTMLDivElement | null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    if (this.classList.contains("canvas-context-menu")) {
      return { ...originalGetBoundingClientRect.call(this), width: 288, height: 133 } as DOMRect;
    }
    if (this.classList.contains("operation-launch-flyout")) {
      return { ...originalGetBoundingClientRect.call(this), width: 216, height: 300 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  tourLayer = null;
});

afterEach(() => {
  act(() => root.unmount());
  tourLayer?.remove();
  container.remove();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
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

    expect(menuStyle().left).toBe("816px");
  });

  it("derives the menu max-height from a short viewport", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 400 });

    expect(menuStyle().getPropertyValue("--canvas-menu-max-height")).toBe("376px");
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
          { id: "claude-native", type: "agent", title: "Claude (Native)" },
          { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
        ],
      },
    ]);

    const gateway = document.querySelectorAll<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]');
    expect(gateway).toHaveLength(1);
    expect(gateway[0]?.textContent).toContain("Claude (Gateway)");
  });

  it("annotates the Claude launch kinds with a description and no extra decoration", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude-native", type: "agent", title: "Claude (Native)" },
          { id: "codex", type: "agent", title: "Codex" },
          { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
          { id: "shell", type: "shell", title: "Shell" },
        ],
      },
    ]);

    const descriptionOf = (kindId: string) =>
      document.querySelector(`[data-operation-launch-kind="${kindId}"] .operation-launch-menu-description`)?.textContent;

    expect(descriptionOf("claude-native")).toBe("Plain Claude Code, without the Admiral prompt");
    expect(descriptionOf("claude-gateway")).toContain("models you enabled in Settings");
    // 설명은 Claude 두 갈래에만 붙는다 — 대비가 필요 없는 종류까지 늘리면 메뉴만 길어진다.
    expect(descriptionOf("codex")).toBeUndefined();
    expect(descriptionOf("shell")).toBeUndefined();

    // 종류 구분은 라벨 괄호 안이 들고 있다 — 항목에 별도 표식을 덧붙이지 않는다.
    expect(document.querySelector(".operation-launch-menu-badge")).toBeNull();
    expect(document.querySelector('[data-operation-launch-kind="claude-gateway"]')?.textContent)
      .toContain("Claude (Gateway)");
  });

  it("shows the disabled reason instead of the description when the CLI cannot launch", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude-native", type: "agent", title: "Claude (Native)", disabled: true, disabledReason: "Not installed" },
        ],
      },
    ]);

    const item = document.querySelector('[data-operation-launch-kind="claude-native"]');
    expect(item?.querySelector(".operation-launch-menu-reason")?.textContent).toBe("Not installed");
    expect(item?.querySelector(".operation-launch-menu-description")).toBeNull();
  });

  it("merges a lone plugin name into the head line and keeps group labels once a second plugin appears", () => {
    const terminal: OperationCatalogPlugin = {
      id: "terminal",
      title: "Terminal",
      kinds: [{ id: "shell", type: "shell", title: "Shell" }],
    };
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [terminal]);

    // 플러그인이 하나면 이름만 있는 행이 값을 못 한다 — 머리글 줄에 붙인다.
    expect(document.querySelector(".canvas-context-menu-plugin")).toBeNull();
    expect(document.querySelector(".canvas-context-menu-head-text")?.textContent).toContain("Terminal");

    const notebooks: OperationCatalogPlugin = {
      id: "notebooks",
      title: "Notebooks",
      kinds: [{ id: "notebook", type: "agent", title: "Notebook" }],
    };
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [terminal, notebooks]);

    // 둘 이상이면 어느 공급자가 어떤 종류를 갖는지 다시 밝혀야 한다.
    const groupLabels = Array.from(document.querySelectorAll(".canvas-context-menu-plugin")).map((node) => node.textContent);
    expect(groupLabels).toEqual(["Terminal", "Notebooks"]);
    expect(document.querySelector(".canvas-context-menu-head-text")?.textContent).not.toContain("Terminal");
    expect(document.querySelectorAll('[role="group"]')).toHaveLength(2);
  });

  it("keeps the kind contrast on the row and opens the full description only for the pointed kind", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude-native", type: "agent", title: "Claude (Native)" },
          { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
        ],
      },
    ]);

    // 짧은 대비는 늘 행 위에 있다 — 터치와 정적 스캔에서도 종류가 갈려야 한다.
    const briefs = Array.from(document.querySelectorAll(".operation-launch-menu-brief")).map((node) => node.textContent);
    expect(briefs).toEqual(["No Admiral", "Other models"]);

    // 설명 문장은 짚기 전에는 옆에 펴지지 않지만, 버튼 안에는 남아 접근 이름에 실린다.
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();
    const gateway = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;
    expect(gateway.textContent).toContain("Runs Claude Code on the models you enabled in Settings");

    act(() => gateway.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")?.textContent)
      .toBe("Runs Claude Code on the models you enabled in Settings");

    // 어사이드는 메뉴 상자 바깥 형제다 — 안에 두면 메뉴의 overflow가 잘라낸다.
    expect(document.querySelector(".canvas-context-menu")?.contains(document.querySelector(".canvas-context-menu-aside"))).toBe(false);
  });

  it("enters the list on the first arrow key and cycles past kinds that cannot launch", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude-native", type: "agent", title: "Claude (Native)" },
          { id: "codex", type: "agent", title: "Codex", disabled: true, disabledReason: "Not installed" },
          { id: "shell", type: "shell", title: "Shell" },
        ],
      },
    ]);

    const menu = document.querySelector<HTMLElement>(".canvas-context-menu")!;
    const activeKind = () => (document.activeElement as HTMLElement | null)?.dataset.operationLaunchKind;

    // 열자마자 아무것도 고르지 않는다 — 이미 선택된 듯 보이면 잘못 누르게 된다.
    expect(document.activeElement).toBe(menu);

    act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(activeKind()).toBe("claude-native");

    // 실행할 수 없는 종류는 건너뛴다.
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(activeKind()).toBe("shell");

    // 끝에서 다시 처음으로 돈다.
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(activeKind()).toBe("claude-native");

    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(activeKind()).toBe("shell");
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(activeKind()).toBe("claude-native");
  });

  it("places the description aside on the side that has room and withholds it when neither does", () => {
    const catalog: readonly OperationCatalogPlugin[] = [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "claude-gateway", type: "agent", title: "Claude (Gateway)" }],
      },
    ];
    const point = () => act(() =>
      document.querySelector('[data-operation-launch-kind="claude-gateway"]')!
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
    const row = document.querySelector('[data-operation-launch-kind="claude-gateway"]')!;
    expect(row.querySelector(".operation-launch-menu-brief")?.textContent).toBe("Other models");
    expect(row.textContent).toContain("models you enabled in Settings");
  });

  it("keys the open description by plugin so two plugins may share a kind id", () => {
    renderMenu({ x: 100, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "claude-native", type: "agent", title: "Claude Local" }],
      },
      {
        id: "remote",
        title: "Remote",
        kinds: [{ id: "claude-gateway", type: "agent", title: "Claude Remote" }],
      },
    ]);

    const rows = document.querySelectorAll<HTMLButtonElement>(".canvas-context-menu-item");
    expect(rows).toHaveLength(2);
    act(() => rows[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")?.textContent)
      .toBe("Runs Claude Code on the models you enabled in Settings");
    act(() => rows[0]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".canvas-context-menu-aside")?.textContent)
      .toContain("without the Admiral prompt");
  });

  it("closes when focus leaves the menu, since its items sit outside the tab order", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "shell", type: "shell", title: "Shell" }],
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
        kinds: [{ id: "claude-native", type: "agent", title: "Claude (Native)" }],
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
          { id: "claude-native", type: "agent", title: "Claude (Native)" },
          { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
        ],
      },
    ]);

    const menu = document.querySelector<HTMLElement>(".canvas-context-menu")!;
    const rows = document.querySelectorAll<HTMLButtonElement>(".canvas-context-menu-item");
    const asideText = () => document.querySelector(".canvas-context-menu-aside")?.textContent;

    // 포인터로 열고 방향키로 옮기는 혼합 입력이 흔하다.
    act(() => rows[0]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => rows[1]!.focus());
    // 가리키는 동안에는 포인터가 이긴다.
    expect(asideText()).toBe("Plain Claude Code, without the Admiral prompt");

    act(() => menu.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    // 포인터가 나가도 포커스가 짚고 있는 행의 설명은 남는다.
    expect(asideText()).toBe("Runs Claude Code on the models you enabled in Settings");
  });

  it("names the menu after its launch target and keeps the visual head out of the menu tree", () => {
    act(() => root.render(
      <CanvasContextMenu
        anchor={{ x: 520, y: 156 }}
        viewportBounds={{ width: 1116, height: 856 }}
        catalog={[{ id: "terminal", title: "Terminal", kinds: [{ id: "shell", type: "shell", title: "Shell" }] }]}
        canLaunch
        theaterLabel="Alpha"
        renderKindIcon={() => null}
        onLaunchKind={vi.fn()}
        onClose={vi.fn()}
      />,
    ));

    const menu = document.querySelector(".canvas-context-menu")!;
    expect(menu.getAttribute("aria-label")).toBe("Alpha controls · Terminal");
    // 같은 문자열이 눈에도 보이지만, 접근성 트리에는 메뉴 이름으로만 한 번 실린다.
    expect(document.querySelector(".canvas-context-menu-head-text")?.textContent).toBe("Alpha controls · Terminal");
    expect(document.querySelector(".canvas-context-menu-head")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives the menu a valid ancestor for its menu items", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [{ id: "shell", type: "shell", title: "Shell" }],
      },
    ]);

    const menu = document.querySelector(".canvas-context-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      expect(item.closest('[role="menu"]')).toBe(menu);
    }
  });

  it("opens launch variants on pointer, suppresses the description aside, and preserves every payload", () => {
    const onLaunchKind = vi.fn();
    const catalog = gatewayVariantCatalog();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, catalog, vi.fn(), false, onLaunchKind);

    const parent = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;
    expect(parent.getAttribute("aria-haspopup")).toBe("menu");
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(parent.querySelector(".operation-launch-menu-chevron")?.textContent).toBe("›");

    act(() => {
      parent.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      parent.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".operation-launch-variant-caption")?.textContent).toBe("Claude built-in");
    expect(document.querySelector(".canvas-context-menu-aside")).toBeNull();

    const row = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;
    // 펼쳐지는 것은 메뉴가 아니라 슬라이더 하나짜리 상자다 — haspopup=menu로 예고하면 보조기술이
    // 메뉴 탐색 모델을 씌워 트랙을 조작 대상으로 보지 않는다.
    expect(row.hasAttribute("aria-haspopup")).toBe(false);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".effort-track")).toBeNull();

    // 강도를 건드리지 않은 행은 모델만 싣는다.
    act(() => row.click());
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0], { model: "fable" });

    // 트랙은 값만 정한다 — 실행은 여전히 모델 행이 일으킨다.
    act(() => row.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const track = document.querySelector<HTMLElement>(".effort-track")!;
    expect(track).not.toBeNull();
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(onLaunchKind).toHaveBeenCalledTimes(1);

    // 고른 강도는 행에 되비치고, 그 행을 눌러야 실행된다.
    expect(document.querySelector(".operation-launch-variant-effort")?.textContent).toBe("MAX");
    act(() => document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!.click());
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0], { model: "fable", effort: "max" });

    act(() => parent.click());
    expect(onLaunchKind).toHaveBeenLastCalledWith("terminal", catalog[0]!.kinds[0]);
  });

  it("clamps the flyout inside narrow horizontal and vertical bounds", () => {
    const bounds = { width: 500, height: 360 };
    renderMenu({ x: 450, y: 320 }, bounds, gatewayVariantCatalog());
    const parent = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;

    act(() => parent.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const flyout = document.querySelector<HTMLElement>(".operation-launch-flyout")!;
    const left = Number.parseFloat(flyout.style.left);
    const top = Number.parseFloat(flyout.style.top);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left).toBeLessThanOrEqual(bounds.width - 216 - 12);
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top).toBeLessThanOrEqual(bounds.height - 300 - 12);
  });

  it("continues the cascade to the right instead of folding onto the parent when both sides fit", () => {
    // 캔버스 왼쪽에서 연 메뉴는 flyout이 오른쪽으로 열린다. 그때 강도 서브메뉴가 "왼쪽 여유가
    // 더 넓다"는 이유로 접히면 부모 메뉴 위에 겹쳐, 짚은 행과 무관한 자리에 뜬 상자가 된다.
    const bounds = { width: 1280, height: 800 };
    renderMenu({ x: 260, y: 100 }, bounds, gatewayVariantCatalog());
    const parent = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;
    act(() => parent.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const flyout = document.querySelector<HTMLElement>(".operation-launch-flyout")!;
    expect(flyout.classList.contains("is-left")).toBe(false);

    const row = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;
    act(() => row.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const effort = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;
    expect(effort.classList.contains("is-left")).toBe(false);
    // 서브메뉴는 flyout 상자의 오른쪽 바깥에 선다 — 부모 위로 되돌아오지 않는다.
    expect(Number.parseFloat(effort.style.left))
      .toBeGreaterThanOrEqual(Number.parseFloat(flyout.style.left) + 216);
  });

  it("keeps the rendered widths in step with the placement constants", () => {
    const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
    const widthOf = (selector: string) =>
      Number(new RegExp(`${selector}\\.theater-menu\\s*\\{[^}]*?width:\\s*(\\d+)px;`, "u").exec(css)?.[1]);
    expect(widthOf("\\.operation-launch-flyout")).toBe(OPERATION_LAUNCH_FLYOUT_WIDTH);
    expect(widthOf("\\.operation-launch-effort-menu")).toBe(OPERATION_LAUNCH_EFFORT_MENU_WIDTH);
  });

  it("follows the model row while the flyout scrolls, and lets go once the row leaves it", () => {
    // 서브메뉴는 fixed라 목록이 굴러도 제자리에 남는다. 짚고 있던 행이 올라가 버리면 그 상자는
    // 엉뚱한 행 옆에서 그 행의 강도인 척하고, 행을 눌러 실행하는 표면에서는 그대로 오실행이 된다.
    const flyoutRect = { top: 100, bottom: 400, left: 0, right: 216, width: 216, height: 300 };
    let anchorRect = { top: 150, bottom: 178, left: 8, right: 208, width: 200, height: 28 };
    const previous = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this.classList.contains("operation-launch-flyout")) return { ...flyoutRect, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
      if (this.classList.contains("operation-launch-variant-entry")) return { ...anchorRect, x: 8, y: anchorRect.top, toJSON: () => ({}) } as DOMRect;
      return previous.call(this);
    };
    try {
      renderMenu({ x: 200, y: 100 }, { width: 1280, height: 420 }, gatewayVariantCatalog());
      const parent = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;
      act(() => parent.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
      const entry = document.querySelector<HTMLElement>(".operation-launch-variant-entry")!;
      act(() => entry.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
      const topAfterOpen = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!.style.top;

      // 행이 아직 flyout 안에 있으면 따라간다.
      anchorRect = { ...anchorRect, top: 120, bottom: 148 };
      act(() => document.querySelector(".operation-launch-flyout")!.dispatchEvent(new Event("scroll")));
      const menu = document.querySelector<HTMLElement>(".operation-launch-effort-menu");
      expect(menu).not.toBeNull();
      expect(menu!.style.top).not.toBe(topAfterOpen);

      // 행이 flyout 위로 사라지면 "그 행의 강도"라는 관계가 끊긴다 — 따라가지 않고 닫는다.
      anchorRect = { ...anchorRect, top: 40, bottom: 68 };
      act(() => document.querySelector(".operation-launch-flyout")!.dispatchEvent(new Event("scroll")));
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
      const parent = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;
      act(() => parent.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
      const row = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;
      act(() => row.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

      const effort = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;
      // maxTop = max(12, 160 - 148 - 12) = 12 — anything taller must land on the margin.
      expect(Number.parseFloat(effort.style.top)).toBe(12);
    } finally {
      Element.prototype.getBoundingClientRect = previousGetBoundingClientRect;
    }
  });

  it("opens the effort submenu from a model row, then restores focus with ArrowLeft", async () => {
    renderMenu({ x: 900, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog());
    const parent = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;

    act(() => {
      parent.focus();
      parent.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const flyout = document.querySelector<HTMLElement>(".operation-launch-flyout")!;
    const row = document.querySelector<HTMLButtonElement>('[data-launch-variant-row="fable"]')!;
    expect(flyout.parentElement).toBe(document.querySelector(".operation-launch-control--canvas"));
    expect(flyout.closest(".canvas-context-menu")).toBeNull();
    expect(flyout.classList.contains("is-left")).toBe(true);
    expect(document.activeElement).toBe(row);

    pressFlyoutKey("ArrowRight");
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const track = document.querySelector<HTMLElement>(".effort-track")!;
    const popup = document.querySelector<HTMLElement>(".operation-launch-effort-menu")!;
    expect(popup).not.toBeNull();
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
    expect(document.querySelector(".operation-launch-flyout")).not.toBeNull();

    pressFlyoutKey("ArrowLeft");
    expect(document.querySelector(".operation-launch-flyout")).toBeNull();
    expect(document.activeElement).toBe(parent);
  });

  it("closes only the flyout on Escape", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, gatewayVariantCatalog(), onClose);
    const parent = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]')!;
    act(() => parent.parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const flyout = document.querySelector<HTMLElement>(".operation-launch-flyout")!;

    act(() => flyout.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(document.querySelector(".operation-launch-flyout")).toBeNull();
    expect(document.activeElement).toBe(parent);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves kinds without variants on the existing direct-launch path", () => {
    const onLaunchKind = vi.fn();
    const catalog: readonly OperationCatalogPlugin[] = [{
      id: "terminal",
      title: "Terminal",
      kinds: [{ id: "shell", type: "shell", title: "Shell" }],
    }];
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, catalog, vi.fn(), false, onLaunchKind);

    const shell = document.querySelector<HTMLButtonElement>('[data-operation-launch-kind="shell"]')!;
    expect(shell.hasAttribute("aria-haspopup")).toBe(false);
    expect(shell.querySelector(".operation-launch-menu-chevron")).toBeNull();
    act(() => shell.click());
    expect(onLaunchKind).toHaveBeenCalledWith("terminal", catalog[0]!.kinds[0]);
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

function renderMenu(
  anchor: { readonly x: number; readonly y: number },
  viewportBounds: { readonly width: number; readonly height: number },
  catalog: readonly OperationCatalogPlugin[] = [],
  onClose = vi.fn(),
  fixed = false,
  onLaunchKind = vi.fn(),
): void {
  act(() => root.render(
    <CanvasContextMenu
      anchor={anchor}
      viewportBounds={viewportBounds}
      fixed={fixed}
      catalog={catalog}
      canLaunch
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
      id: "claude-gateway",
      type: "agent",
      title: "Claude (Gateway)",
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

function pressFlyoutKey(key: string): void {
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

function menuStyle(): CSSStyleDeclaration {
  return document.querySelector<HTMLElement>(".operation-launch-control--canvas")!.style;
}
