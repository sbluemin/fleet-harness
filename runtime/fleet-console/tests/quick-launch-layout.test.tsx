import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OPERATION_LAUNCH_EFFORT_MENU_WIDTH } from "../core/client/src/canvas/canvas-context-menu.js";

const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
const quickLaunch = readFileSync(resolve(process.cwd(), "core/client/src/components/quick-launch.tsx"), "utf8");

describe("Quick Launch composer layout", () => {
  it("centers the overlay with symmetric viewport padding", () => {
    const overlay = ruleFor(".quick-launch-overlay");
    expect(overlay).toMatch(/place-items:\s*center;/u);
    expect(overlay).toMatch(/padding:\s*var\(--space-5\);/u);
    expect(overlay).not.toMatch(/14vh/u);
  });

  it("clamps the downward popover to the viewport while retaining its cap", () => {
    const pop = ruleFor(".quick-launch-pop");
    expect(pop).toMatch(/max-height:\s*min\(340px,\s*var\(--quick-launch-pop-max-height,\s*340px\)\);/u);
    expect(quickLaunch).toMatch(/getBoundingClientRect\(\)\.top/iu);
    expect(quickLaunch).toMatch(/window\.innerHeight\s*-\s*top\s*-\s*safePadding/u);
    expect(quickLaunch).not.toMatch(/50vh|64px/u);
    expect(pop).toMatch(/overflow-y:\s*auto;/u);
  });

  it("keeps the model popover at its measured compact width", () => {
    expect(css).toMatch(/\.quick-launch-pop--model\s*\{[^}]*width:\s*216px;/u);
  });

  it("keeps the send control an icon-only circle", () => {
    const submit = ruleFor(".quick-launch-submit");
    expect(submit).toMatch(/border-radius:\s*999px/u);
    expect(submit).toMatch(/width:\s*32px/u);
    // 버튼 안에 또 배지를 얹으면 하나의 표면이 두 겹이 된다.
    expect(css).not.toMatch(/\.quick-launch-submit\s+kbd/u);
    // esc 힌트는 제거됐다 — apex 확장이 바를 넓히면서 힌트가 바를 두 줄로 밀었다.
    expect(css).not.toMatch(/\.quick-launch-esc/u);
    expect(quickLaunch).not.toMatch(/escHint/u);
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

describe("Quick Launch docking", () => {
  it("moves by transform so the dock interpolates and the bottom edge holds while it collapses", () => {
    // place-items를 바꾸면 보간되지 않아 카드가 튄다. translateY의 50%는 카드 자기 높이라
    // 접혀 높이가 줄어도 아래 모서리는 제자리에 남는다.
    expect(ruleFor(".quick-launch-card.is-pinned")).toMatch(/transform:\s*translateY\(calc\(50vh - var\(--space-4\) - 50%\)\);/u);
    expect(ruleFor(".quick-launch-card")).toMatch(/transform var\(--duration-slow\) var\(--ease-spring\)/u);
  });

  it("releases the modal contract while docked so the screen behind stays usable", () => {
    expect(quickLaunch).toMatch(/aria-modal=\{pinned \? undefined : true\}/u);
    // 스크롤 잠금·포커스 탈취·Tab 가둠은 모두 모달 전용이다(고정 중에는 뒤 화면을 계속 쓴다).
    expect(quickLaunch).toMatch(/if \(!open \|\| pinned\) return;/u);
    expect(quickLaunch).toMatch(/document\.addEventListener\("keydown", onKeyDown, true\);/u);
    expect(ruleFor(".quick-launch-overlay.is-pinned")).toMatch(/pointer-events:\s*none;/u);
    expect(ruleFor(".quick-launch-card.is-pinned")).toMatch(/pointer-events:\s*auto;/u);
  });

  it("renders the pin only where it can be pressed, so its presence is the tour's gate", () => {
    // 물러난 바의 컨트롤은 높이 0 + inert다 — 버튼을 남기면 안내가 가리킬 것 없는 자리를 짚고,
    // 상태 클래스로 앵커를 거르면 옵저버가 class를 보지 않아 펼친 뒤에도 다시 서지 않는다.
    expect(quickLaunch).toMatch(/\{dockSuppressed \|\| showStrip \? null : \(/u);
  });

  it("folds the mention deck away when the dock loses focus", () => {
    // 덱은 카드 직속이라 접힘에도 inert에도 걸리지 않는다 — 남기면 물러난 바 위로 목록이 떠서
    // 도킹이 되돌려 준 화면을 도로 가린다.
    expect(quickLaunch).toMatch(/setPopover\(null\);[\s\S]{0,220}setMentionToken\(null\);[\s\S]{0,40}setCollapsed\(true\);/u);
  });

  it("reads the pin state when an async submission settles, not when it was dispatched", () => {
    // 멘션 전달 중에 고정을 풀면, 넘길 때 닫아 둔 값으로는 모달을 닫지 못해 빈 대화가 남는다.
    expect(quickLaunch).toMatch(/if \(!isQuickLaunchDocked\(\)\) \{/u);
  });

  it("keeps a tour card that points into the composer inside its focus scope", () => {
    // 안내 카드는 스스로 포커스를 가져가지 않고 컴포저 밖에 렌더된다 — 트랩이 카드를 빼면 키보드로는
    // 안내를 닫을 수 없고, 카드에만 핸들러를 걸면 카드에서 나가는 Tab이 모달 뒤로 샌다.
    expect(quickLaunch).toMatch(/FEATURE_TOUR_LAYER_SELECTOR/u);
    expect(quickLaunch).toMatch(/const scopes = \[card, \.\.\.Array\.from\(document\.querySelectorAll<HTMLElement>\(FEATURE_TOUR_LAYER_SELECTOR\)\)\];/u);
  });

  it("collapses and recedes as one state, and holds both back while a message is showing", () => {
    expect(ruleFor(".quick-launch-card.is-pinned.is-collapsed")).toMatch(/opacity:\s*var\(--quick-launch-idle-opacity\);/u);
    // 접힘은 펼친 높이를 선언한 기저 규칙과 특정도가 같으면 조용히 진다 — .is-pinned를 함께 물어야
    // 이긴다(실브라우저에서 max-height가 320px로 남는 회귀로 확인된 계약).
    expect(ruleFor(".quick-launch-card.is-pinned.is-collapsed .quick-launch-field")).toMatch(/max-height:\s*0;/u);
    expect(css).not.toMatch(/^\.quick-launch-card\.is-collapsed \.quick-launch-(?:field|bar),?$/mu);
    expect(quickLaunch).toMatch(/const showStrip = pinned && collapsed && !holdsMessage;/u);
    expect(quickLaunch).toMatch(/rejectionKey !== null \|\| mentionErrorKey !== null \|\| overLimit/u);
  });

  it("keeps the collapsed controls out of the tab order", () => {
    // max-height:0만으로는 Tab이 보이지 않는 컨트롤에 닿는다 — 멘션 접힘과 같은 inert 계약.
    expect(quickLaunch).toMatch(/className="quick-launch-field" inert=\{showStrip \|\| undefined\}/u);
    expect(quickLaunch).toMatch(/className="quick-launch-bar" ref=\{barRef\} inert=\{showStrip \|\| undefined\}/u);
  });

  it("opens the docked popover upward and never clips it away", () => {
    expect(ruleFor(".quick-launch-card.is-pinned .quick-launch-pop")).toMatch(/bottom:\s*calc\(100% \+ var\(--space-2\)\);/u);
    expect(quickLaunch).toMatch(/bar\.getBoundingClientRect\(\)\.top - safePadding/u);
    // 접힘은 자르기를 요구하지만 팝오버는 바 밖으로 서는 바의 자식이다 — 열린 동안에는 놓는다.
    expect(css).toMatch(/\.quick-launch-card\.is-pinned:not\(\.has-popover\) \.quick-launch-bar \{[^}]*overflow:\s*hidden;/u);
  });

  it("leaves one control behind when collapsed, carrying the draft it would otherwise hide", () => {
    expect(quickLaunch).toMatch(/className="quick-launch-strip"/u);
    // 접힌 줄의 빈 상태는 컴포저 플레이스홀더와 같은 초대 문구다 — 키를 나누면 둘이 어긋난다.
    expect(quickLaunch).toMatch(/draftTrace\.length === 0 \? t\("chrome\.quickLaunch\.placeholder"\) : draftTrace/u);
    // 펼친 동안에는 접근성 트리와 탭 순서 어디에도 없어야 한다.
    expect(ruleFor(".quick-launch-strip")).toMatch(/display:\s*none;/u);
    expect(ruleFor(".quick-launch-card.is-collapsed .quick-launch-strip")).toMatch(/display:\s*flex;/u);
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

  it("writes the normalized model and effort at selection time", () => {
    expect(quickLaunch).toMatch(/const nextEffort = resolveRowEffort\(row, effort\);[\s\S]*setModel\(nextModel\);[\s\S]*setEffort\(nextEffort\);[\s\S]*writeQuickLaunchModelEffort\(nextModel, nextEffort\);/u);
    expect(quickLaunch).toMatch(/onChange=\{\(nextEffort\) => \{[\s\S]*setEffort\(nextEffort\);[\s\S]*writeQuickLaunchModelEffort\(model, nextEffort\);/u);
  });

  it("waits for the seeded model to resolve against the catalog before submission", () => {
    // 다른 plugin 카탈로그에 Opus가 없을 수 있다. passive 정규화 effect 전 한 프레임에서도 버튼과
    // Enter 제출 모두 invalid opus[1m]을 보내면 안 되므로 같은 selectedRow gate를 공유한다.
    // 멘션 제출은 런치 좌표가 필요 없으므로 launch 분기에만 이 gate가 선다.
    expect(quickLaunch).toMatch(/if \(!theaterId \|\| !target \|\| !selectedRow\) return;/u);
    expect(quickLaunch).toMatch(/\(mentionTarget !== null \|\| \(!!theaterId && !!target && !!selectedRow\)\);/u);
    // submitting 재진입 가드는 버튼과 Enter가 공유하는 유일한 이중 제출 방지선이다.
    expect(quickLaunch).toMatch(/\|\| submitting\) return;/u);
    expect(quickLaunch).toMatch(/&& !submitting && !deckHasRows/u);
  });

  it("gives the track a fixed berth instead of letting it compete with the spacer", () => {
    // 셸은 max-content, 트랙 폭은 캔버스 추론강도와 같은 116px 비례 규칙을 쓴다.
    const rule = ruleFor(".quick-launch-effort-track");
    expect(rule).toMatch(/flex:\s*0 0 auto/u);
    expect(rule).toMatch(/width:\s*max-content/u);
    expect(css).not.toMatch(/\.quick-launch-effort-track \.effort-track \{[^}]*flex:\s*1/u);
    expect(css).toMatch(/\.effort-track \{[^}]*--effort-closed-track-width:\s*116px/u);
  });
});

describe("canvas effort submenu", () => {
  it("sizes the flyout to its content so labels are not clipped", () => {
    // 고정 폭이면 짧을 때 잘리고 길면 빈 칸이 남는다 — max-content가 둘을 막는다.
    const rule = ruleFor(".operation-launch-effort-menu.theater-menu");
    expect(rule).toMatch(/width:\s*max-content/u);
    expect(css).not.toMatch(/\.operation-launch-effort-menu\.theater-menu:has\([^)]*\)\s*\{[^}]*width:\s*\d+px/u);
  });

  it("keeps the placement constant as an open-state ceiling", () => {
    expect(OPERATION_LAUNCH_EFFORT_MENU_WIDTH).toBeGreaterThanOrEqual(300);
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
