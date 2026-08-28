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
  it("draws every Operation row as an activity beacon", () => {
    const view = render([operation("agent-row", "agent")]);
    const card = view.querySelector<HTMLElement>(".mobile-operation-card");

    expect(card?.querySelector(".tenant-beacon")).not.toBeNull();
    // Shell은 확대 표면으로 옮겨 갔으므로 종류 글리프가 서던 자리가 사라졌다.
    expect(card?.querySelector(".shell-kind-mark")).toBeNull();
  });
});
