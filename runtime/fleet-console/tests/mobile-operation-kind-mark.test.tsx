// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MobileOperationList } from "../core/client/src/mobile/mobile-operation-list.js";
import type { OperationNode } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function operation(id: string, type: string): OperationNode {
  return {
    id,
    theaterId: "theater-1",
    type,
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  } as OperationNode;
}

function render(operations: readonly OperationNode[]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(MobileOperationList, {
    operations,
    operationRuntime: {},
    notificationIds: new Set<string>(),
    theaterLabel: "Alpha",
    onOpen: () => {},
  })));
  return container;
}

/**
 * 모바일 목록도 데스크톱 칩·커맨드 밴드·지도 점과 같은 판단을 쓴다 — Shell은 활동 축을 발행하지
 * 않으므로 비콘 자리를 종류 글리프가 가져간다. 표면마다 다르게 그리면 같은 사실이 표면 수만큼의
 * 이야기로 갈라진다.
 */
describe("mobile operation list kind mark", () => {
  it("draws a shell as the kind glyph and an agent as the activity beacon", () => {
    const view = render([operation("shell-row", "shell"), operation("agent-row", "agent")]);

    const cards = [...view.querySelectorAll(".mobile-operation-card")];
    expect(cards).toHaveLength(2);
    const shellCard = cards.find((card) => card.textContent?.includes("shell-row"));
    const agentCard = cards.find((card) => card.textContent?.includes("agent-row"));

    expect(shellCard?.querySelector(".shell-kind-mark svg")).not.toBeNull();
    expect(shellCard?.querySelector(".tenant-beacon")).toBeNull();
    // 목록 카드는 이미 자기 제목을 읽어 주고, 유휴/종료라는 사실은 섹션 머리글이 진다.
    expect(shellCard?.querySelector(".shell-kind-mark")?.getAttribute("aria-hidden")).toBe("true");

    expect(agentCard?.querySelector(".tenant-beacon.is-idle")).not.toBeNull();
    expect(agentCard?.querySelector(".shell-kind-mark")).toBeNull();
  });

  it("keeps a shell inside the same status section as an agent with the same activity", () => {
    const view = render([operation("shell-row", "shell"), operation("agent-row", "agent")]);

    const sections = [...view.querySelectorAll(".mobile-status-section")];
    const idle = sections.find((section) => section.querySelector("h2")?.textContent === "Idle");
    expect(idle?.querySelectorAll(".mobile-operation-card")).toHaveLength(2);
  });
});
