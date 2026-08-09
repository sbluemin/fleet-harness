import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OPERATION_LAUNCH_EFFORT_MENU_WIDTH } from "../core/client/src/canvas/canvas-context-menu.js";

const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
const quickLaunch = readFileSync(resolve(process.cwd(), "core/client/src/components/quick-launch.tsx"), "utf8");

describe("Quick Launch composer layout", () => {
  it("keeps the model popover at its measured compact width", () => {
    expect(css).toMatch(/\.quick-launch-pop--model\s*\{[^}]*width:\s*216px;/u);
  });

  it("keeps the send control an icon-only circle and the key hint untouchable", () => {
    const submit = ruleFor(".quick-launch-submit");
    expect(submit).toMatch(/border-radius:\s*999px/u);
    expect(submit).toMatch(/width:\s*32px/u);
    // 버튼 안에 또 배지를 얹으면 하나의 표면이 두 겹이 된다.
    expect(css).not.toMatch(/\.quick-launch-submit\s+kbd/u);
    // 힌트는 읽히되 만져지지 않는다 — 테두리나 배경을 주면 바 위에서 액션 행세를 한다.
    const esc = ruleFor(".quick-launch-esc");
    expect(esc).not.toMatch(/border/u);
    expect(esc).not.toMatch(/background/u);
  });

  it("names the send control for assistive tech, since it carries no visible label", () => {
    const button = /className="quick-launch-submit"[\s\S]*?<\/button>/u.exec(quickLaunch);
    if (!button) throw new Error("Expected the submit button markup");
    expect(button[0]).toMatch(/aria-label=\{t\("chrome\.quickLaunch\.runWithKey"\)\}/u);
  });

  it("lets the label claim the row so a starred model keeps the list's left edge", () => {
    for (const selector of [".quick-launch-variant-star", ".operation-launch-variant-star"]) {
      expect(ruleFor(selector)).not.toMatch(/margin-left:\s*auto/u);
    }
    expect(ruleFor(".quick-launch-variant-label")).toMatch(/flex:\s*1;/u);
  });

  it("gives both launch menus the same default-model star", () => {
    const canvas = ruleFor(".operation-launch-variant-star");
    expect(canvas).toBe(ruleFor(".quick-launch-variant-star"));
    expect(canvas).toMatch(/font-family:\s*var\(--font-body\)/u);
    expect(canvas).toMatch(/font-size:\s*10px/u);
  });
});

describe("Quick Launch effort surface", () => {
  it("carries effort on the bar, not in a submenu the model list has to open", () => {
    // 강도가 팝오버 밖으로 나오면서 서브메뉴 표면 자체가 사라졌다 — 겹칠 상자가 없다.
    expect(css).not.toMatch(/quick-launch-effort-menu/u);
    expect(css).not.toMatch(/quick-launch-effort-item/u);
    expect(quickLaunch).toMatch(/<EffortTrack/u);
    expect(quickLaunch).not.toMatch(/QuickLaunchEffortMenu/u);
  });

  it("folds the track away for a model with no ladder", () => {
    // 조작할 수 없는 컨트롤이 자리를 지키면 바가 고장 난 것처럼 읽힌다.
    expect(quickLaunch).toMatch(/selectedRow && \(selectedRow\.chips\?\.length \?\? 0\) > 0/u);
  });

  it("waits for the seeded model to resolve against the catalog before submission", () => {
    // 다른 plugin 카탈로그에 Opus가 없을 수 있다. passive 정규화 effect 전 한 프레임에서도 버튼과
    // Enter 제출 모두 invalid opus[1m]을 보내면 안 되므로 같은 selectedRow gate를 공유한다.
    expect(quickLaunch).toMatch(/\|\| !target \|\| !selectedRow \|\| submitting\) return;/u);
    expect(quickLaunch).toMatch(/&& !!target && !!selectedRow && !submitting;/u);
  });

  it("gives the track a fixed berth instead of letting it compete with the spacer", () => {
    // 남는 폭을 두고 겨루게 두면 트랙이 스톱 간격보다 좁아져 손잡이가 이웃 스톱을 덮는다.
    const rule = ruleFor(".quick-launch-effort-track");
    expect(rule).toMatch(/flex:\s*0 0 auto/u);
    expect(rule).toMatch(/width:\s*204px/u);
  });
});

describe("canvas effort submenu", () => {
  it("keeps the rendered width in step with the placement constant", () => {
    const declared = /\.operation-launch-effort-menu\.theater-menu\s*\{[^}]*?width:\s*(\d+)px;/u.exec(css)?.[1];
    expect(Number(declared)).toBe(OPERATION_LAUNCH_EFFORT_MENU_WIDTH);
  });
});

// 선언 블록을 셀렉터로 찾아 돌려준다. 정규식을 곧장 `.test()`로 쓰면 셀렉터가 사라지거나 다른
// 규칙과 묶였을 때도 "매칭 없음 = 위반 없음"으로 읽혀 조용히 통과한다.
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "mu").exec(css);
  if (!block) throw new Error(`Expected a CSS rule for ${selector}`);
  return block[1]!;
}
