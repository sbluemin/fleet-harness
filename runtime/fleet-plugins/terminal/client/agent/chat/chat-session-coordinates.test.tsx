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
const model = () => container?.querySelector<HTMLElement>(".agent-chat-coord-model");
const modelName = () => container?.querySelector<HTMLElement>(".agent-chat-coord-model-name");
/** 강도 축은 읽기 전용 계기다 — 이름을 지는 요소는 셸이 아니라 그 안의 트랙이다. */
const effortAxis = () => container?.querySelector<HTMLElement>(".agent-chat-coord-effort .effort-track");
const effortLabel = () => container?.querySelector<HTMLElement>(".agent-chat-coord-effort-label");
const birth = () => container?.querySelector<HTMLElement>(".agent-chat-birth");

describe("chat session coordinates", () => {
  it("states the session's model and effort on the composer's control row", () => {
    mount({ launchModel: "opus[1m]", launchEffort: "ultra" });
    expect(modelName()?.textContent).toBe("Opus");
    expect(effortLabel()?.textContent).toBe("ULTRACODE");
    expect(effortLabel()?.dataset.effortLevel).toBe("ultra");
    // 두 축은 따로 선다 — 런치 표면과 같은 문법(모델은 칩, 강도는 축)이라야 같은 세션을
    // 두 표면이 같은 말로 부른다.
    expect(effortAxis()?.dataset.effortLevel).toBe("ultra");
    // 축약하지 않은 사실은 툴팁에 남는다.
    expect(chip()?.getAttribute("title")).toBe("opus[1m] · ultra");
  });

  // 좌표는 사실이지 컨트롤이 아니다 — 세션이 실행 정책을 소유하므로 여기서 바꿀 수 없다.
  // 누를 수 있게 그리면 거짓 약속이 된다.
  it("is a named mark, not an interactive control", () => {
    mount({ launchModel: "sonnet", launchEffort: "high" });
    expect(chip()?.tagName).toBe("SPAN");
    expect(chip()?.querySelector("button")).toBeNull();
    // 강도 축은 트랙과 같은 그림을 쓰되 손잡이도, 슬라이더 역할도, 탭 정지점도 갖지 않는다 —
    // 만질 수 있게 그리면 "여기서 바꿀 수 있다"는 거짓 약속이 된다.
    expect(effortAxis()?.dataset.readonly).toBe("true");
    expect(effortAxis()?.getAttribute("role")).toBe("img");
    expect(effortAxis()?.hasAttribute("tabindex")).toBe(false);
    expect(chip()?.querySelector(".effort-track-knob")).toBeNull();
    expect(chip()?.querySelector(".effort-track-needle")).not.toBeNull();
    // 일반 span의 aria-label은 무시될 수 있다 — 이름을 지는 역할이 있어야 한 문장으로 읽힌다.
    expect(model()?.getAttribute("role")).toBe("img");
    expect(model()?.getAttribute("aria-label")).toBe("This session runs on Sonnet");
    expect(effortAxis()?.getAttribute("aria-label")).toBe("Effort HIGH — fixed for this session");
  });

  it("marks only an ultracode session with the apex channel", () => {
    mount({ launchModel: "opus[1m]", launchEffort: "xhigh" });
    expect(model()?.classList.contains("is-ultracode")).toBe(false);
    expect(birth()?.classList.contains("is-ultracode")).toBe(false);
    act(() => root?.unmount());
    container?.remove();
    mount({ launchModel: "opus[1m]", launchEffort: "ultra" });
    expect(model()?.classList.contains("is-ultracode")).toBe(true);
    expect(birth()?.classList.contains("is-ultracode")).toBe(true);
  });

  it("says the coordinates were left to the default instead of naming a model", () => {
    mount({});
    expect(modelName()?.textContent).toBe("Default");
    expect(effortLabel()?.textContent).toBe("AUTO");
    expect(effortLabel()?.dataset.effortLevel).toBe("auto");
    // 자동은 사다리의 최소 단이 아니라 사다리를 쓰지 않는 상태다 — 채움도 지침도 서지 않는다.
    expect(effortAxis()?.dataset.auto).toBe("true");
    expect(chip()?.querySelector(".effort-track-needle")).toBeNull();
    expect(chip()?.hasAttribute("title")).toBe(false);
    expect(model()?.getAttribute("aria-label")).toBe("This session runs on Default");
  });

  // 태생 기록은 로그의 첫 줄이다 — 연결 고지보다 앞이며, 턴이 하나도 없어도 서 있다.
  it("records the starting coordinates as the log's first line", () => {
    mount({ launchModel: "opus[1m]", launchEffort: "ultra" }, "ko");
    const log = container?.querySelector(".agent-chat-log");
    expect(log?.firstElementChild?.classList.contains("agent-chat-birth")).toBe(true);
    expect(birth()?.textContent).toContain("Opus · ULTRACODE 좌표로 시작");
  });
});
