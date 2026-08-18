// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatComposer } from "./composer.js";

const uploads: File[] = [];
let stops = 0;
vi.mock("../api.js", () => ({
  messageAgentSession: async () => {},
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
  stops = 0;
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

function mount(options: { readonly turnRunning?: boolean } = {}): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = {
    operationId: "op-1",
    language: "en",
    operation: { id: "op-1", title: "Fresh chat", payload: {} },
  } as unknown as OperationRenderContext;
  act(() => root?.render(createElement(AgentChatComposer, {
    context,
    coordinate: createElement("span", { className: "coord-stub" }),
    tourAnchor: false,
    turnRunning: options.turnRunning ?? false,
    stopping: false,
    onStop: async () => { stops += 1; },
  })));
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

  // 발사 컨트롤은 하나다 — 떠 있는 중지 배지를 따로 두면 지금 도는 일을 멈추는 자리가 둘로 갈린다.
  it("turns the send control into stop while a turn runs", async () => {
    mount({ turnRunning: true });
    const send = container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send");
    expect(send?.classList.contains("is-stopping")).toBe(true);
    expect(send?.getAttribute("aria-label")).toBe("Stop this turn");
    expect(container?.querySelector(".agent-chat-composer-stop-mark")).not.toBeNull();
    await act(async () => { send?.click(); });
    expect(stops).toBe(1);

    act(() => root?.unmount());
    container?.remove();
    mount();
    const idle = container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send");
    expect(idle?.classList.contains("is-stopping")).toBe(false);
    // 초안이 없으면 발사도 없다 — 눌러도 아무 일이 없는 죽은 컨트롤을 만들지 않는다.
    expect(idle?.disabled).toBe(true);
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
