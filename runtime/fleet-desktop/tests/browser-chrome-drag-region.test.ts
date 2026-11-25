import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 가로 탭 표시줄은 창의 제목 표시줄이다. 바탕(여백·탭 사이·새 탭 단추 뒤)은 창을 끌고, 탭과 단추는 누름을 받는다.
 * 끌기 영역은 OS 가 창 수준에서 가로채므로 브라우저에서 다시 볼 수 없다 — 규칙이 어긋나지 않게 선언 자체를 대조한다.
 */
const css = fs.readFileSync(new URL("../assets/browser-chrome/chrome.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const railSource = fs.readFileSync(new URL("../src/chrome/doc/rail.ts", import.meta.url), "utf8");

/** 선택자가 정확히 일치하는 규칙들의 선언을 모은다. */
function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(/,(?![^()]*\))/).map((part) => part.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    for (const declaration of match[2]!.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) found.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }
  return found;
}

describe("가로 탭 표시줄의 창 끌기 영역", () => {
  it("표시줄 바탕과 양 끝 여백이 창을 끈다", () => {
    expect(declarations(".rail.horizontal").get("-webkit-app-region")).toBe("drag");
    expect(declarations(".rail.horizontal > .pad").get("-webkit-app-region")).toBe("drag");
  });

  it("탭(닫기 단추 포함)과 새 탭 단추는 끌기에서 빠져 누름을 받는다", () => {
    expect(declarations(".rail.horizontal :is(.tab, .row)").get("-webkit-app-region")).toBe("no-drag");
  });

  it("탭이 줄을 가득 채워도 끝 여백이 끌 자리로 남는다", () => {
    const minWidth = declarations(".rail.horizontal > .pad:last-child").get("min-width") ?? "";
    expect(minWidth).toMatch(/^\d+px$/);
    expect(Number.parseInt(minWidth, 10)).toBeGreaterThanOrEqual(32);
  });

  it("표시줄 메뉴가 떠 있는 동안은 끌기를 내려 바탕 누름이 메뉴를 닫는다", () => {
    expect(declarations(".rail.horizontal.menu-open").get("-webkit-app-region")).toBe("no-drag");
    expect(declarations(".rail.horizontal.menu-open > .pad").get("-webkit-app-region")).toBe("no-drag");
    expect(railSource).toMatch(/classList\.toggle\("menu-open", state\.overlay\?\.kind === "tabs-menu"\)/);
  });

  it("탭 묶음은 탭들의 최소 폭 합보다 줄지 않는다 — 줄면 넘친 탭이 새 탭 단추를 덮는다", () => {
    expect(declarations(".rail.horizontal .tabs").get("min-width")).toBe("0");
    expect(railSource).toMatch(/tabsBox\.style\.minWidth = `\$\{Math\.ceil\(floor\)\}px`/);
    expect(railSource).toMatch(/holdTabsMinimum\(\);\s*fitTabs\(\);/);
  });

  it("세로 레일은 끌기 영역을 갖지 않는다", () => {
    expect(declarations(".rail").has("-webkit-app-region")).toBe(false);
    expect(declarations(".rail > .pad").has("-webkit-app-region")).toBe(false);
  });
});
