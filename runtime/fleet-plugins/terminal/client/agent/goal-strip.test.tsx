// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock은 파일 최상단으로 끌어올려지므로 팩토리 안에서 모듈 스코프 변수를 붙잡을 수 없다.
vi.mock("./goal-api.js", () => ({
  clearSessionGoal: vi.fn(async () => {}),
  setSessionGoal: vi.fn(async () => undefined),
}));

import { clearSessionGoal } from "./goal-api.js";
import { GoalStrip } from "./goal-strip.js";
import { applySessionUpdate, getAgentState, removeSession } from "./store.js";
import type { SessionGoal, SessionInfo } from "./types.js";

const SESSION_ID = "goal-strip-operation";
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let expanded = true;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  removeSession(SESSION_ID);
  container?.remove();
  root = null;
  container = null;
  expanded = true;
  vi.mocked(clearSessionGoal).mockClear();
});

describe("goal strip", () => {
  // 목표를 해제하면 영수증만 사라지고 진입점은 남아야 한다. 머리글이 함께 사라지면
  // 살아 있는 Operation에 새 목표를 걸 방법이 아예 없어진다.
  it("keeps a reachable entry point after the goal is cleared", async () => {
    render({ state: "active", live: true, origin: "fleet", checksUsed: 1, checkLimit: 8, condition: "ship it" });

    // 접힌 탭은 유일한 표면이므로 상태를 말해야 한다. 펼치면 아래 줄이 그 역할을 넘겨받는다.
    act(() => { rerender(false); });
    expect(tab().textContent).toContain("목표 진행 중");
    act(() => { rerender(true); });
    expect(tab().textContent).not.toContain("목표 진행 중");

    const clearButton = action("목표 해제");
    expect(clearButton).not.toBeNull();

    await act(async () => { clearButton!.click(); });

    expect(clearSessionGoal).toHaveBeenCalledWith(SESSION_ID);
    // 해제는 줄을 접는다 — 설정 시트를 즉시 들이밀지 않는다.
    expect(expanded).toBe(false);
    // 목표가 없으면 탭은 상태를 말하지 않는다 — 서랍을 여는 손잡이로만 남는다.
    expect(tab().textContent).not.toContain("목표 진행 중");

    // 그 머리글을 다시 열면 곧바로 목표 설정 시트다.
    act(() => { rerender(true); });
    expect(container?.querySelector(".terminal-goal-sheet")).not.toBeNull();
  });

  // 예산은 한 줄이다. 어느 상태에서도 본문의 자식은 하나여야 한다 — 둘이 되는 순간 두 줄이다.
  it("keeps the drawer to a single line in every state", () => {
    render({ state: "active", live: true, origin: "fleet", checksUsed: 1, checkLimit: 8, condition: "ship it" });
    expect(lineCount()).toBe(1);
    // 강제 중에는 "무엇을 시켰나"가 앞선다.
    expect(container?.querySelector(".terminal-goal-detail")?.textContent).toBe("ship it");

    act(() => { applySessionUpdate(session({ state: "met", live: true, origin: "fleet", checksUsed: 2, checkLimit: 8, condition: "ship it" })); });
    act(() => { rerender(expanded); });
    expect(lineCount()).toBe(1);
    // 끝난 뒤에는 판정을 어디까지 믿을 수 있는지가 앞서고, 조건문은 title로 남는다.
    const detail = container?.querySelector(".terminal-goal-detail");
    expect(detail?.textContent).toContain("트랜스크립트");
    expect(detail?.getAttribute("title")).toContain("ship it");

    act(() => { applySessionUpdate(session(undefined)); });
    act(() => { rerender(expanded); });
    expect(lineCount()).toBe(1);
    expect(container?.querySelector(".terminal-goal-sheet")).not.toBeNull();
  });

  // 박동은 "지금 강제 중"이라는 뜻이다. 끝난 목표까지 박동하면 탭이 거짓을 말한다.
  it("pulses the tab only while a goal is actually being enforced", () => {
    render({ state: "active", live: true, origin: "fleet", checksUsed: 1, checkLimit: 8, condition: "ship it" });
    expect(container?.querySelector(".terminal-goal-pulse")).not.toBeNull();

    act(() => { applySessionUpdate(session({ state: "met", live: true, origin: "fleet", checksUsed: 2, checkLimit: 8 })); });
    act(() => { rerender(expanded); });
    expect(container?.querySelector(".terminal-goal-pulse")).toBeNull();
  });

  // 종료된 목표는 해제 대신 "지우기"를 내밀고, 그와 별개로 새 목표를 걸 수 있어야 한다.
  it("offers both dismiss and a new goal once a goal has ended on a live session", () => {
    render({ state: "met", live: true, origin: "fleet", checksUsed: 2, checkLimit: 8, totalChecks: 3, condition: "ship it" });

    expect(action("지우기")).not.toBeNull();
    expect(action("목표 설정")).not.toBeNull();
  });
});

function render(goal: SessionGoal | undefined): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  applySessionUpdate(session(goal));
  act(() => { rerender(expanded); });
}

function rerender(nextExpanded: boolean): void {
  expanded = nextExpanded;
  const current = getAgentState().sessions[SESSION_ID] ?? session(undefined);
  root?.render(createElement(GoalStrip, {
    session: current,
    language: "ko",
    expanded,
    onToggleExpanded: () => { act(() => { rerender(!expanded); }); },
  }));
}

function session(goal: SessionGoal | undefined): SessionInfo {
  return {
    sessionId: SESSION_ID,
    terminalSessionId: SESSION_ID,
    cwdLabel: "Workspace",
    cliId: "claude",
    status: "registered",
    turnState: "running",
    createdAt: 1,
    resumeAvailable: true,
    ...(goal ? { goal } : {}),
  };
}

function lineCount(): number {
  return container?.querySelector(".terminal-goal-body-inner")?.children.length ?? 0;
}

function tab(): HTMLButtonElement {
  const element = container?.querySelector<HTMLButtonElement>(".terminal-goal-tab");
  if (!element) throw new Error("Goal tab must render.");
  return element;
}

function action(label: string): HTMLButtonElement | null {
  return [...(container?.querySelectorAll<HTMLButtonElement>(".terminal-goal-actions button") ?? [])]
    .find((button) => button.textContent?.trim() === label) ?? null;
}
