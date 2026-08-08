// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { AiGatewayPriorityChips, composeAiGatewayRemoval } from "./index.js";
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

function render(
  priority: readonly AiGatewayProviderId[],
  onToggle: (id: AiGatewayProviderId) => void,
): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(AiGatewayPriorityChips, {
      providers: PROVIDERS,
      priority,
      saving: false,
      onToggle,
    }));
  });
  const group = container.querySelector<HTMLElement>(".ai-gateway-priority");
  expect(group).not.toBeNull();
  return group!;
}

function chips(group: HTMLElement): HTMLButtonElement[] {
  return [...group.querySelectorAll<HTMLButtonElement>(".ai-gateway-priority-chip")];
}

describe("AiGatewayPriorityChips", () => {
  it("renders one chip per provider and marks listed ones with their rank", () => {
    const group = render(["cursor", "codex"], () => {});
    const buttons = chips(group);
    expect(buttons).toHaveLength(4);

    // 카탈로그 순서(codex, cursor, ...)로 그리되, 순위는 사용자가 고른 순서를 말한다.
    const codex = buttons[0]!;
    const cursor = buttons[1]!;
    expect(codex.getAttribute("aria-pressed")).toBe("true");
    expect(codex.querySelector(".ai-gateway-priority-rank")?.textContent).toBe("2");
    expect(cursor.getAttribute("aria-pressed")).toBe("true");
    expect(cursor.querySelector(".ai-gateway-priority-rank")?.textContent).toBe("1");

    const kimi = buttons[2]!;
    expect(kimi.getAttribute("aria-pressed")).toBe("false");
    expect(kimi.querySelector(".ai-gateway-priority-rank")).toBeNull();
  });

  it("toggles membership through clicks — append for unlisted, remove for listed", () => {
    const onToggle = vi.fn();
    const group = render(["cursor"], onToggle);
    const buttons = chips(group);

    act(() => buttons[0]!.click());
    expect(onToggle).toHaveBeenLastCalledWith("codex");
    act(() => buttons[1]!.click());
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
    const group = render(["kimi"], () => {});
    const kimi = chips(group)[2]!;
    // aria-label은 결과 행동(제거)과 순위를 함께 말한다 — 숫자 배지 자체는 aria-hidden이다.
    expect(kimi.getAttribute("aria-label")).toContain("1");
    expect(kimi.querySelector(".ai-gateway-priority-rank")?.getAttribute("aria-hidden")).toBe("true");
  });
});
