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
    snapshotting: false,
    observedTurns: 0,
    errorCode: null,
    jobs: [],
    context: null,
    queue: [],
    connection: "open",
    stopTurn: async () => {},
    cancelQueued: async () => {},
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
    tourAnchors: false,
  })));
}

const chip = () => container?.querySelector(".agent-chat-coord");
const effort = () => container?.querySelector<HTMLElement>(".agent-chat-coord-effort");

describe("chat session coordinates", () => {
  it("states the session's model and effort in the chip row", () => {
    mount({ session: { harness: "claude-code", model: "opus[1m]", effort: "ultra" } });
    expect(chip()?.querySelector(".agent-chat-coord-model")?.textContent).toBe("Opus");
    expect(effort()?.textContent).toBe("ULTRACODE");
    expect(effort()?.dataset.effortLevel).toBe("ultra");
    // 축약하지 않은 사실은 툴팁에 남는다.
    expect(chip()?.getAttribute("title")).toBe("opus[1m] · ultra");
  });

  // 좌표는 사실이지 컨트롤이 아니다 — 세션이 실행 정책을 소유하므로 여기서 바꿀 수 없다.
  // 누를 수 있게 그리면 거짓 약속이 된다.
  it("is a named mark, not an interactive control", () => {
    mount({ session: { harness: "claude-code", model: "sonnet", effort: "high" } });
    expect(chip()?.tagName).toBe("SPAN");
    expect(chip()?.querySelector("button")).toBeNull();
    // 일반 span의 aria-label은 무시될 수 있다 — 이름을 지는 역할이 있어야 한 문장으로 읽힌다.
    expect(chip()?.getAttribute("role")).toBe("img");
    expect(chip()?.getAttribute("aria-label")).toBe("This session runs on Sonnet at HIGH");
  });

  it("marks only an ultracode session with the apex channel", () => {
    mount({ session: { harness: "claude-code", model: "opus[1m]", effort: "xhigh" } });
    expect(chip()?.classList.contains("is-ultracode")).toBe(false);
    act(() => root?.unmount());
    container?.remove();
    mount({ session: { harness: "claude-code", model: "opus[1m]", effort: "ultra" } });
    expect(chip()?.classList.contains("is-ultracode")).toBe(true);
  });

  // 이름만으로는 같은 자리에 선 두 모델이 어디서 온 것인지 말하지 못한다.
  it("marks the supplier that actually ran, and falls back to the neutral mark", () => {
    mount({ session: { harness: "claude-code", model: "claude-gateway--xai--grok-4.6", effort: "high" } });
    expect(chip()?.querySelector(".agent-chat-coord-glyph")?.getAttribute("data-provider")).toBe("xai");
    expect(chip()?.querySelector(".agent-chat-coord-glyph svg")).not.toBeNull();
    // 글리프는 마크 자리를 잇는다 — 둘이 함께 서면 줄의 리듬이 어긋난다.
    expect(chip()?.querySelector(".agent-chat-coord-mark")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    // ultracode는 그 자리에 자기 별을 세운다 — 티어가 공급자보다 먼저 읽혀야 한다.
    mount({ session: { harness: "claude-code", model: "claude-gateway--xai--grok-4.6", effort: "ultra" } });
    expect(chip()?.querySelector(".agent-chat-coord-mark")?.textContent).toBe("✦");
    expect(chip()?.querySelector(".agent-chat-coord-glyph")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    // 공급자를 읽지 못한 세션은 중립 마름모로 돌아간다.
    mount({});
    expect(chip()?.querySelector(".agent-chat-coord-glyph")).toBeNull();
    expect(chip()?.querySelector(".agent-chat-coord-mark")?.textContent).toBe("◇");
  });

  it("says the coordinates were left to the default instead of naming a model", () => {
    mount({});
    expect(chip()?.querySelector(".agent-chat-coord-model")?.textContent).toBe("Default");
    expect(effort()?.textContent).toBe("AUTO");
    expect(effort()?.dataset.effortLevel).toBe("auto");
    expect(chip()?.hasAttribute("title")).toBe(false);
    expect(chip()?.getAttribute("aria-label")).toBe("This session runs on Default at AUTO");
  });

  // 좌표를 말하는 자리는 하나다 — 컴포저의 배지가 상시로 서 있으므로 로그가 같은 사실을
  // 첫 줄에 한 번 더 적지 않는다.
  it("leaves the log to the conversation and keeps the coordinates on the composer", () => {
    mount({ session: { harness: "claude-code", model: "opus[1m]", effort: "ultra" } }, "ko");
    expect(container?.querySelector(".agent-chat-birth")).toBeNull();
    expect(container?.querySelector(".agent-chat-composer-bar .agent-chat-coord")).not.toBeNull();
  });
});
