// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";

vi.mock("./chat-store.js", () => ({
  useAgentChatStream: () => ({
    turns: [],
    replaying: false,
    replayedTurns: 0,
    errorCode: null,
    jobs: [],
    context: null,
    connection: "open",
    stopTurn: async () => {},
    answerAsk: async () => {},
  }),
}));
vi.mock("../api.js", () => ({ readAgentChatJobDetail: async () => null }));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() { /* noop */ }
    disconnect() { /* noop */ }
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function mount(payload: Record<string, unknown>, language: "en" | "ko" = "en"): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language,
    runtimeState: { lifecycle: "live", activity: "idle" },
    operation: {
      id: "op-1",
      theaterId: "theater-1",
      type: "agent",
      pluginId: "terminal",
      title: "op",
      payload,
      geometry: null,
      ts: { createdAt: 0, updatedAt: 0 },
    },
  } as unknown as OperationRenderContext;
  act(() => root?.render(createElement(AgentChatView, {
    context,
    onOpenTerminal: async () => {},
    tourAnchors: false,
  })));
}

const chip = () => container?.querySelector(".agent-chat-coord");
const effort = () => container?.querySelector<HTMLElement>(".agent-chat-coord-effort");
const birth = () => container?.querySelector<HTMLElement>(".agent-chat-birth");

describe("chat session coordinates", () => {
  it("states the session's model and effort in the chip row", () => {
    mount({ launchModel: "opus[1m]", launchEffort: "ultra" });
    expect(chip()?.querySelector(".agent-chat-coord-model")?.textContent).toBe("Opus");
    expect(effort()?.textContent).toBe("ULTRACODE");
    expect(effort()?.dataset.effortLevel).toBe("ultra");
    // 축약하지 않은 사실은 툴팁에 남는다.
    expect(chip()?.getAttribute("title")).toBe("opus[1m] · ultra");
  });

  // 좌표는 사실이지 컨트롤이 아니다 — 세션이 실행 정책을 소유하므로 여기서 바꿀 수 없다.
  // 누를 수 있게 그리면 거짓 약속이 된다.
  it("is not an interactive control", () => {
    mount({ launchModel: "sonnet", launchEffort: "high" });
    expect(chip()?.tagName).toBe("SPAN");
    expect(chip()?.querySelector("button")).toBeNull();
    expect(container?.querySelector(".agent-chat-coord[role]")).toBeNull();
  });

  it("marks only an ultracode session with the apex channel", () => {
    mount({ launchModel: "opus[1m]", launchEffort: "xhigh" });
    expect(chip()?.classList.contains("is-ultracode")).toBe(false);
    expect(birth()?.classList.contains("is-ultracode")).toBe(false);
    act(() => root?.unmount());
    container?.remove();
    mount({ launchModel: "opus[1m]", launchEffort: "ultra" });
    expect(chip()?.classList.contains("is-ultracode")).toBe(true);
    expect(birth()?.classList.contains("is-ultracode")).toBe(true);
  });

  it("says the coordinates were left to the default instead of naming a model", () => {
    mount({});
    expect(chip()?.querySelector(".agent-chat-coord-model")?.textContent).toBe("Default");
    expect(effort()?.textContent).toBe("AUTO");
    expect(effort()?.dataset.effortLevel).toBe("auto");
    expect(chip()?.hasAttribute("title")).toBe(false);
    expect(chip()?.getAttribute("aria-label")).toBe("This session runs on Default at AUTO");
  });

  // 태생 기록은 로그의 첫 줄이다 — 연결 고지보다 앞이며, 턴이 하나도 없어도 서 있다.
  it("records the starting coordinates as the log's first line", () => {
    mount({ launchModel: "opus[1m]", launchEffort: "ultra" }, "ko");
    const log = container?.querySelector(".agent-chat-log");
    expect(log?.firstElementChild?.classList.contains("agent-chat-birth")).toBe(true);
    expect(birth()?.textContent).toContain("Opus · ULTRACODE 좌표로 시작");
  });
});
