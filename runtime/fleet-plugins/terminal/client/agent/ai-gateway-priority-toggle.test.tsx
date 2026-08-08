// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { AiGatewayPriorityToggle, composeAiGatewayRemoval } from "./index.js";
import type { AiGatewayProviderId } from "./settings.js";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const PROVIDERS: readonly AiGatewayProviderId[] = ["codex", "cursor", "kimi", "opencode"];

/** 카드가 공급자 헤드마다 토글 하나를 그리는 자리를 그대로 재현한다. */
function render(
  priority: readonly AiGatewayProviderId[],
  onToggle: (id: AiGatewayProviderId) => void,
): HTMLButtonElement[] {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement("div", null, ...PROVIDERS.map((provider) => createElement(
      AiGatewayPriorityToggle,
      { key: provider, provider, rank: priority.indexOf(provider), saving: false, onToggle },
    ))));
  });
  const toggles = [...container.querySelectorAll<HTMLButtonElement>(".ai-gateway-priority-toggle")];
  expect(toggles).toHaveLength(PROVIDERS.length);
  return toggles;
}

describe("AiGatewayPriorityToggle", () => {
  it("marks the listed providers with their rank and leaves the rest unranked", () => {
    const toggles = render(["cursor", "codex"], () => {});

    // 토글은 공급자 헤드에 하나씩 붙으므로 카탈로그 순서로 서지만, 숫자는 사용자가 고른 순서다.
    const codex = toggles[0]!;
    const cursor = toggles[1]!;
    expect(codex.getAttribute("aria-pressed")).toBe("true");
    expect(codex.querySelector(".ai-gateway-priority-rank")?.textContent).toBe("2");
    expect(cursor.getAttribute("aria-pressed")).toBe("true");
    expect(cursor.querySelector(".ai-gateway-priority-rank")?.textContent).toBe("1");

    const kimi = toggles[2]!;
    expect(kimi.getAttribute("aria-pressed")).toBe("false");
    expect(kimi.classList.contains("is-ranked")).toBe(false);
    expect(kimi.querySelector(".ai-gateway-priority-rank")).toBeNull();
  });

  it("toggles membership through clicks — append for unlisted, remove for listed", () => {
    const onToggle = vi.fn();
    const toggles = render(["cursor"], onToggle);

    act(() => toggles[0]!.click());
    expect(onToggle).toHaveBeenLastCalledWith("codex");
    act(() => toggles[1]!.click());
    expect(onToggle).toHaveBeenLastCalledWith("cursor");
  });

  // 이 카드의 저장은 우선순위 키를 항상 에코하므로, 제거 본문이 선택 스프레드를 빠뜨리면
  // 모델 제거 한 번이 저장된 소진 순서를 명시 해제([])로 둔갑시킨다 — 실측된 P1 회귀.
  it("keeps providerPriority and the default when composing a model removal", () => {
    const removed = composeAiGatewayRemoval({
      models: [{ id: "cursor--grok-4.5" }, { id: "kimi--k3" }],
      defaultModel: "cursor--grok-4.5",
      providerPriority: ["codex"],
    }, "kimi--k3");
    expect(removed).toEqual({
      models: [{ id: "cursor--grok-4.5" }],
      defaultModel: "cursor--grok-4.5",
      providerPriority: ["codex"],
    });

    // 기본 모델 자체를 제거하면 기본값만 접히고 우선순위는 남는다.
    const removedDefault = composeAiGatewayRemoval({
      models: [{ id: "cursor--grok-4.5" }],
      defaultModel: "cursor--grok-4.5",
      providerPriority: ["codex", "cursor"],
    }, "cursor--grok-4.5");
    expect(removedDefault).toEqual({
      models: [],
      providerPriority: ["codex", "cursor"],
    });
  });

  it("keeps rank presentation out of the accessible name and states the action instead", () => {
    const kimi = render(["kimi"], () => {})[2]!;
    // aria-label은 결과 행동(제거)과 순위를 함께 말한다 — 숫자 배지 자체는 aria-hidden이다.
    expect(kimi.getAttribute("aria-label")).toContain("1");
    expect(kimi.getAttribute("aria-label")).toContain("Kimi");
    expect(kimi.querySelector(".ai-gateway-priority-rank")?.getAttribute("aria-hidden")).toBe("true");
  });

  // 의미를 말하던 라벨·도움말 줄이 헤드 이전과 함께 사라졌으므로, 요약 말풍선이 항상 딸려야
  // 한다. 접근성 이름은 행동만 말하므로 말풍선은 aria-hidden으로 중복 낭독을 막는다.
  it("ships a one-line meaning summary as a hover bubble on every toggle, ranked or not", () => {
    const toggles = render(["codex"], () => {});
    for (const toggle of toggles) {
      const tip = toggle.querySelector(".ai-gateway-priority-tip");
      expect(tip).not.toBeNull();
      expect(tip!.getAttribute("aria-hidden")).toBe("true");
      expect((tip!.textContent ?? "").length).toBeGreaterThan(0);
    }
    // 네이티브 title이 함께 붙으면 같은 hover에서 말풍선이 두 겹으로 열린다.
    expect(toggles[0]!.hasAttribute("title")).toBe(false);
  });
});
