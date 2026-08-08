// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuickLaunchEffortMenu, QUICK_LAUNCH_EFFORT_MENU_WIDTH } from "../core/client/src/components/quick-launch-effort-menu.js";

let container: HTMLDivElement;
let anchor: HTMLButtonElement;
let root: Root;
let anchorRect: DOMRect;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  anchorRect = rect({ left: 100, top: 80, width: 264, height: 32 });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    if (this === anchor) return anchorRect;
    if (this.classList.contains("quick-launch-effort-menu")) return rect({ width: 104, height: 72 });
    return originalGetBoundingClientRect.call(this);
  };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  container = document.createElement("div");
  anchor = document.createElement("button");
  container.append(anchor);
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelector(".quick-launch-effort-menu")?.remove();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

describe("Quick Launch effort submenu layout", () => {
  it("portals the submenu outside the model list and opens to the right when it fits", () => {
    renderMenu();

    const menu = effortMenu();
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.left).toBe("370px");
    expect(menu.style.top).toBe("80px");
    expect(menu.classList.contains("is-left")).toBe(false);
  });

  it("flips left only when the right side exceeds the viewport margin", () => {
    anchorRect = rect({ left: 620, top: 80, width: 264, height: 32 });
    renderMenu();

    const menu = effortMenu();
    expect(menu.style.left).toBe("510px");
    expect(menu.classList.contains("is-left")).toBe(true);
  });

  it("measures from the popover box, not the row inside its padding", () => {
    // 행은 팝오버 안쪽 패딩만큼 좁다. 행에 붙이면 서브메뉴가 그만큼 팝오버 위로 파고들어
    // 짚고 있던 행의 오른쪽 끝을 덮는다.
    const popover = document.createElement("div");
    popover.className = "quick-launch-pop quick-launch-pop--model";
    container.append(popover);
    popover.append(anchor);
    const popoverRect = rect({ left: 92, top: 72, width: 280, height: 300 });
    const previous = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this === popover) return popoverRect;
      return previous.call(this);
    };
    try {
      renderMenu();
      // 팝오버 오른쪽 끝(372) + 간격 6 — 행 오른쪽 끝(364)이 아니다.
      expect(effortMenu().style.left).toBe("378px");
    } finally {
      Element.prototype.getBoundingClientRect = previous;
    }
  });

  it("keeps the model popover and the effort submenu at their measured compact widths", () => {
    const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
    expect(css).toMatch(/\.quick-launch-pop--model\s*\{[^}]*width:\s*216px;/u);
    // CSS 폭과 배치 계산의 폴백 상수가 어긋나면 컴파일은 되고 위치만 조용히 틀어진다.
    const declared = /\.quick-launch-effort-menu\.theater-menu\s*\{[^}]*?width:\s*(\d+)px;/u.exec(css)?.[1];
    expect(Number(declared)).toBe(QUICK_LAUNCH_EFFORT_MENU_WIDTH);
  });

  it("lets the label claim the row so a starred model keeps the list's left edge", () => {
    // ★에 margin-left:auto를 걸면 그 행만 통째로 우측 정렬돼 목록의 기준선이 끊긴다.
    const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
    for (const selector of [".quick-launch-variant-star", ".operation-launch-variant-star"]) {
      expect(ruleFor(css, selector)).not.toMatch(/margin-left:\s*auto/u);
    }
    expect(ruleFor(css, ".quick-launch-variant-label")).toMatch(/flex:\s*1;/u);
  });

  it("gives both launch menus the same default-model star", () => {
    // 조판을 행에서 상속시키면 mono를 쓰는 캔버스 쪽 ★가 sans를 쓰는 Quick Launch 쪽의 절반
    // 폭으로 렌더돼, 같은 뜻의 표식이 표면마다 다른 기호로 읽힌다.
    const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
    const canvas = ruleFor(css, ".operation-launch-variant-star");
    expect(canvas).toBe(ruleFor(css, ".quick-launch-variant-star"));
    expect(canvas).toMatch(/font-family:\s*var\(--font-body\)/u);
    expect(canvas).toMatch(/font-size:\s*10px/u);
  });

  it("styles the selected effort with aria-current to match the rendered attribute", () => {
    const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
    expect(css).toMatch(/\.quick-launch-effort-item\[aria-current="true"\]/u);
    expect(css).not.toMatch(/\.quick-launch-effort-item\[aria-pressed="true"\]/u);
  });
});

function renderMenu(): void {
  act(() => root.render(
    <QuickLaunchEffortMenu
      anchor={anchor}
      menuRef={createRef<HTMLDivElement>()}
      open
      onCancelClose={() => {}}
      onScheduleClose={() => {}}
      onClose={() => {}}
      onReturnFocus={() => {}}
    >
      <button type="button" className="quick-launch-effort-item">HIGH</button>
    </QuickLaunchEffortMenu>,
  ));
}

// 선언 블록을 셀렉터로 찾아 돌려준다. 정규식을 곧장 `.test()`로 쓰면 셀렉터가 사라지거나 다른
// 규칙과 묶였을 때도 "매칭 없음 = 위반 없음"으로 읽혀 조용히 통과한다.
function ruleFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "mu").exec(css);
  if (!block) throw new Error(`Expected a CSS rule for ${selector}`);
  return block[1]!;
}

function effortMenu(): HTMLElement {
  const menu = document.querySelector<HTMLElement>(".quick-launch-effort-menu");
  if (!menu) throw new Error("Expected effort menu");
  return menu;
}

function rect({ left = 0, top = 0, width = 0, height = 0 }: {
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
}): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}
