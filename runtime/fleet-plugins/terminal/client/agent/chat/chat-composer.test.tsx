// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatComposer } from "./composer.js";

const uploads: File[] = [];
const messages: string[] = [];
let stops = 0;
let queued = 0;
let queueRejected = 0;
let messageDelivery: "resolve" | "reject" | "hold" = "resolve";
let releaseMessage: (() => void) | null = null;
vi.mock("../api.js", () => ({
  messageAgentSession: async (_operationId: string, text: string) => {
    messages.push(text);
    if (messageDelivery === "reject") throw new Error("delivery failed");
    if (messageDelivery === "hold") await new Promise<void>((resolve) => { releaseMessage = resolve; });
  },
  uploadLaunchAttachment: async (file: File) => {
    uploads.push(file);
    return { id: `att-${uploads.length}` };
  },
  discardLaunchAttachment: async () => {},
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  uploads.length = 0;
  messages.length = 0;
  stops = 0;
  queued = 0;
  queueRejected = 0;
  messageDelivery = "resolve";
  releaseMessage = null;
  // jsdom에는 객체 URL이 없다 — 미리보기 경로가 컴포저 렌더를 막지 않게 최소 구현을 세운다.
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: () => "blob:preview",
    revokeObjectURL: () => {},
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function composerProps(options: { readonly turnRunning?: boolean; readonly queuedTurns?: number } = {}) {
  const context = {
    operationId: "op-1",
    language: "en",
    operation: { id: "op-1", title: "Fresh chat", payload: {} },
  } as unknown as OperationRenderContext;
  return {
    context,
    coordinate: createElement("span", { className: "coord-stub" }),
    meter: null,
    tourAnchor: false,
    turnRunning: options.turnRunning ?? false,
    stopping: false,
    queuedTurns: options.queuedTurns ?? 0,
    // 잡이 없으면 백그라운드 작업 글리프는 서지 않는다 — 이 스위트는 전송·큐 문법만 다룬다.
    work: {
      running: 0,
      hasJobs: false,
      open: false,
      controlsId: "op-1-work",
      onOpen: () => {},
    },
    onStop: async () => { stops += 1; return true; },
    onQueued: () => { queued += 1; },
    onQueueRejected: () => { queueRejected += 1; },
  };
}

function mount(options: { readonly turnRunning?: boolean; readonly queuedTurns?: number } = {}): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(AgentChatComposer, composerProps(options))));
}

const input = () => container?.querySelector<HTMLTextAreaElement>(".agent-chat-composer-input");

describe("chat panel composer", () => {
  // 상시 노출 — 매 턴 앞에 붙던 "펼치는 클릭" 하나가 이 패널의 기본 동작을 가리고 있었다.
  it("stands open with no folded strip to come back from", () => {
    mount();
    expect(input()).not.toBeNull();
    expect(container?.querySelector(".agent-chat-composer-rest")).toBeNull();
    // 되찾은 세로는 입력 행수로 돌아간다 — 크롬이 85%를 쓰던 자리다.
    expect(input()?.rows).toBe(3);
    // 좌표는 컨트롤 행이 진다.
    expect(container?.querySelector(".agent-chat-composer-bar .coord-stub")).not.toBeNull();
  });

  // 키 안내는 셋째 줄이 아니라 컨트롤 행에 세 든다.
  it("carries the key hints on the control row, not a third line", () => {
    mount();
    const hint = container?.querySelector(".agent-chat-composer-hint");
    expect(hint?.parentElement?.classList.contains("agent-chat-composer-bar")).toBe(true);
    expect(hint?.textContent).toContain("Enter to send");
    // 접힘이 퇴역했으므로 Esc 안내도 함께 사라진다.
    expect(hint?.textContent).not.toContain("Esc");
  });

  // Quick Launch에서 되고 채팅뷰에서 안 되던 능력 비대칭을 닫는다.
  it("takes an image paste and leaves a text paste to the browser", async () => {
    mount();
    const field = input();
    expect(field).not.toBeNull();

    const image = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const imagePaste = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData?: { files: readonly File[] };
    };
    Object.defineProperty(imagePaste, "clipboardData", { value: { files: [image] } });
    await act(async () => { field?.dispatchEvent(imagePaste); });
    expect(imagePaste.defaultPrevented).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(container?.querySelectorAll(".agent-chat-composer-attachment")).toHaveLength(1);

    // 이미지가 실리지 않은 붙여넣기는 가로채지 않는다 — 기본 동작 그대로 흘러야 한다.
    const textPaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", { value: { files: [] } });
    await act(async () => { field?.dispatchEvent(textPaste); });
    expect(textPaste.defaultPrevented).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("stands stop and queue-next as separate controls while a turn runs", async () => {
    mount({ turnRunning: true });
    const stop = container?.querySelector<HTMLButtonElement>(".agent-chat-composer-stop");
    const queue = container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send.is-queue");
    expect(stop?.textContent).toContain("Stop current");
    expect(stop?.getAttribute("aria-label")).toBe("Stop this turn");
    expect(queue?.getAttribute("aria-label")).toBe("Queue next (Enter)");
    expect(queue?.disabled).toBe(true);

    const field = input();
    await act(async () => {
      if (!field) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "check the tests");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(queue?.disabled).toBe(false);
    await act(async () => { queue?.click(); });
    expect(messages).toEqual(["check the tests"]);
    expect(queued).toBe(1);

    await act(async () => { stop?.click(); });
    expect(stops).toBe(1);

    act(() => root?.unmount());
    container?.remove();
    mount();
    expect(container?.querySelector(".agent-chat-composer-stop")).toBeNull();
    const idle = container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send");
    expect(idle?.classList.contains("is-queue")).toBe(false);
    expect(idle?.disabled).toBe(true);
  });

  it("restores focus only after an acknowledged stop", async () => {
    mount({ turnRunning: true });
    const stop = container?.querySelector<HTMLButtonElement>(".agent-chat-composer-stop");
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();

    // 정상 완료는 사용자가 작업 면에 둔 초점을 빼앗지 않는다.
    act(() => root?.render(createElement(AgentChatComposer, composerProps({ turnRunning: false }))));
    expect(document.activeElement).toBe(elsewhere);

    act(() => root?.render(createElement(AgentChatComposer, composerProps({ turnRunning: true }))));
    await act(async () => { container?.querySelector<HTMLButtonElement>(".agent-chat-composer-stop")?.click(); });
    expect(stops).toBe(1);
    expect(document.activeElement).toBe(input());
    stop?.remove();
    elsewhere.remove();
  });

  it("records a queued receipt before delivery settles and rolls it back on rejection", async () => {
    mount({ turnRunning: true });
    const field = input();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "queue this");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    messageDelivery = "hold";
    let delivery: Promise<void> | undefined;
    act(() => {
      delivery = (async () => {
        container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send.is-queue")?.click();
        await Promise.resolve();
      })();
    });
    await act(async () => { await Promise.resolve(); });
    expect(queued).toBe(1);
    releaseMessage?.();
    await act(async () => { await delivery; });
    expect(queueRejected).toBe(0);

    messageDelivery = "reject";
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "reject this");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
      container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send.is-queue")?.click();
      await Promise.resolve();
    });
    expect(queued).toBe(2);
    expect(queueRejected).toBe(1);
  });

  it("keeps a visible receipt for accepted queued turns", () => {
    mount({ turnRunning: true, queuedTurns: 2 });
    const receipt = container?.querySelector(".agent-chat-composer-queued");
    expect(receipt?.getAttribute("role")).toBe("status");
    expect(receipt?.textContent).toBe("2 next instructions queued");
  });

  // Quick Launch와 같은 `ultracode` 무장을 이 컴포저도 진다 — 같은 부품(sdk/composer)이
  // 인식·미러 문법을 소유하고, 표식만 이 조립이 싣는다.
  function type(value: string, caret = value.length): void {
    const field = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
    if (field) field.selectionStart = field.selectionEnd = caret;
  }

  it("arms on a recognized ultracode word and paints the mirror, token, and notice", async () => {
    mount();
    await act(async () => { type("do it ultracode"); });
    const frame = container?.querySelector(".agent-chat-composer-frame");
    expect(frame?.classList.contains("is-ultracode")).toBe(true);
    expect(container?.querySelector(".agent-chat-composer-highlight")).not.toBeNull();
    expect(container?.querySelector(".agent-chat-composer-ultracode-token")?.textContent).toBe("ultracode");
    const notice = container?.querySelector(".agent-chat-composer-ultracode-notice");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("Dynamic workflow");

    // 단어가 아닌 형태(부분·접미)는 무장하지 않는다.
    await act(async () => { type("run ultracoder"); });
    expect(container?.querySelector(".agent-chat-composer-frame")?.classList.contains("is-ultracode")).toBe(false);
  });

  it("disarms on a bare Backspace right after the word, and stays disarmed until it is retyped", async () => {
    mount();
    await act(async () => { type("do it ultracode"); });

    // caret이 인식된 토큰 바로 뒤일 때의 수식 없는 Backspace는 글자가 아니라 무장을 지운다.
    await act(async () => {
      input()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    expect(container?.querySelector(".agent-chat-composer-frame")?.classList.contains("is-ultracode")).toBe(false);
    // 문면은 그대로다 — 지운 것은 무장이지 글자가 아니다.
    expect(input()?.value).toBe("do it ultracode");

    // 같은 단어를 계속 고쳐도 다시 켜지지 않는다.
    await act(async () => { type("do it ultracode now"); });
    expect(container?.querySelector(".agent-chat-composer-frame")?.classList.contains("is-ultracode")).toBe(false);
    // 단어가 문면에서 사라지면 해제도 만료한다 — 다시 치면 새 의사표시로 무장한다.
    await act(async () => { type("do it"); });
    await act(async () => { type("do it ultracode"); });
    expect(container?.querySelector(".agent-chat-composer-frame")?.classList.contains("is-ultracode")).toBe(true);
  });

  // 파일 드롭은 이미지가 아니어도 기본 동작을 막는다 — 막지 않으면 브라우저가 그 파일로
  // 내비게이션해 콘솔째로 떠난다.
  it("blocks a file drop from navigating the console away", async () => {
    mount();
    const frame = container?.querySelector(".agent-chat-composer-frame");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    await act(async () => { frame?.dispatchEvent(drop); });
    expect(drop.defaultPrevented).toBe(true);
    // 이미지가 아니므로 조용히 지나간다 — 사유를 말하지 않는다.
    expect(uploads).toHaveLength(0);
    expect(container?.querySelector(".agent-chat-composer-error")).toBeNull();
  });
});
