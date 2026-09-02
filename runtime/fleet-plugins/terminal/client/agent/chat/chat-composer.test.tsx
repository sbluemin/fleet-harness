// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatComposer } from "./composer.js";
import type { AgentChatCatalog } from "./chat-events.js";

const uploads: File[] = [];
const messages: string[] = [];
let stops = 0;
let meterOpens = 0;
let renames: string[] = [];
let renameFails = false;
/** 덱과 Console 라우팅이 함께 읽는 카탈로그. `null`이면 "아직 모른다"이고 라우팅은 쉰다. */
let catalogPayload: AgentChatCatalog | null = null;
let catalogFetches = 0;
let canceled: string[] = [];
let cancelOutcome: "canceled" | "started" | "unreachable" = "canceled";
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
  readAgentChatCatalog: async () => { catalogFetches += 1; return catalogPayload; },
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  uploads.length = 0;
  messages.length = 0;
  stops = 0;
  canceled = [];
  cancelOutcome = "canceled";
  messageDelivery = "resolve";
  releaseMessage = null;
  meterOpens = 0;
  renames = [];
  renameFails = false;
  catalogPayload = null;
  catalogFetches = 0;
  // jsdom에는 scrollIntoView가 없다 — 덱이 활성 행을 따라가며 부른다.
  if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
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

interface MountOptions {
  readonly turnRunning?: boolean;
  readonly queue?: readonly { readonly id: string; readonly text: string }[];
  readonly catalogEpoch?: number;
}

function composerProps(options: MountOptions = {}) {
  const context = {
    operationId: "op-1",
    language: "en",
    operation: { id: "op-1", title: "Fresh chat", payload: {} },
    operations: {
      rename: async (_id: string, title: string) => {
        if (renameFails) throw new Error("rename failed");
        renames.push(title);
        return {};
      },
    },
  } as unknown as OperationRenderContext;
  return {
    context,
    coordinate: createElement("span", { className: "coord-stub" }),
    meter: null,
    tourAnchor: false,
    turnRunning: options.turnRunning ?? false,
    stopping: false,
    queue: options.queue ?? [],
    onStop: async () => { stops += 1; return true; },
    onCancelQueued: async (queueId: string) => {
      canceled.push(queueId);
      return cancelOutcome;
    },
    coordinates: { model: null, effort: null },
    onOpenContextMeter: () => { meterOpens += 1; },
    catalogEpoch: options.catalogEpoch ?? 0,
  };
}

function mount(options: MountOptions = {}): void {
  // 같은 테스트가 두 번 세울 수 있다(전이 뒤의 상태를 보는 검사). 앞의 뿌리를 걷지 않으면
  // 그 마운트가 문서에 남아, 다음 질의는 새 컨테이너를 보는데 리스너는 둘이 산다.
  if (root) act(() => root?.unmount());
  container?.remove();
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
    // Quick Launch와 같은 한 줄 intrinsic 높이에서 시작하고, CSS 46px 하한 위로 내용만큼 자란다.
    expect(input()?.rows).toBe(1);
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
    // 중지는 라벨을 벗고 첨부와 같은 글리프로 선다 — 이름은 aria/title이 지고, 표식만 남는다.
    expect(stop?.textContent).toBe("");
    expect(stop?.querySelector(".agent-chat-composer-stop-mark")).not.toBeNull();
    expect(stop?.getAttribute("aria-label")).toBe("Stop this turn (Esc)");
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

  // 예약은 수가 아니라 목록이다 — 무엇이 밀려 있는지 문면으로 서야 사용자가 자기 초안을
  // 잃었는지 예약됐는지 가릴 수 있다. 목록의 권위는 서버이고 화면은 그대로 그린다.
  it("stands the queued instructions as their own text, in order", () => {
    mount({ turnRunning: true, queue: [{ id: "q1", text: "first" }, { id: "q2", text: "second" }] });
    const items = [...container?.querySelectorAll(".agent-chat-composer-queue-item") ?? []];
    expect(items.map((item) => item.querySelector(".agent-chat-composer-queue-text")?.textContent))
      .toEqual(["first", "second"]);
    expect(items.map((item) => item.querySelector(".agent-chat-composer-queue-ord")?.textContent))
      .toEqual(["1", "2"]);
    // 빈 큐는 자리를 차지하지 않는다 — 도는 중이라는 사실만으로 서면 대화가 그만큼 밀린다.
    mount({ turnRunning: true });
    expect(container?.querySelector(".agent-chat-composer-queue")).toBeNull();
  });

  it("cancels a queued instruction by its own coordinate", async () => {
    mount({ turnRunning: true, queue: [{ id: "q1", text: "first" }, { id: "q2", text: "second" }] });
    const cancels = container?.querySelectorAll<HTMLButtonElement>(".agent-chat-composer-queue-cancel");
    await act(async () => { cancels?.[1]?.click(); });
    expect(canceled).toEqual(["q2"]);
    // 칩은 낙관적으로 지우지 않는다 — 목록을 내리는 것은 서버가 보내는 다음 큐 스냅숏이다.
    expect(container?.querySelectorAll(".agent-chat-composer-queue-item").length).toBe(2);
    expect(container?.querySelector(".agent-chat-composer-error")).toBeNull();
  });

  // 취소가 한 발 늦으면 그 지시는 이미 도는 턴이다. ok로 삼키면 사용자는 취소되지 않은 턴을
  // 취소된 것으로 읽으므로, 남은 길(중지)을 그 자리에서 말한다.
  it("says so when the cancel lost the race to the turn starting", async () => {
    cancelOutcome = "started";
    mount({ turnRunning: true, queue: [{ id: "q1", text: "first" }] });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".agent-chat-composer-queue-cancel")?.click();
    });
    const notice = container?.querySelector(".agent-chat-composer-error");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("already started");
  });

  // 더블클릭 한 번이면 같은 좌표로 두 요청이 나가고, 두 번째는 첫 번째가 이미 거둔 좌표를 찾지
  // 못해 거절된다. 그 거절을 그대로 읽으면 취소에 **성공한** 사용자에게 턴을 중지하라고 말한다.
  it("sends one cancel per coordinate however often the button is activated", async () => {
    mount({ turnRunning: true, queue: [{ id: "q1", text: "first" }] });
    const button = container?.querySelector<HTMLButtonElement>(".agent-chat-composer-queue-cancel");
    await act(async () => {
      button?.click();
      button?.click();
      button?.click();
    });
    expect(canceled).toEqual(["q1"]);
    expect(container?.querySelector(".agent-chat-composer-error")).toBeNull();
  });

  // 서버에 닿지도 못한 실패를 "이미 시작했다"로 읽으면, 연결이 끊긴 사용자에게 멈추지 않아도 될
  // 턴을 멈추라고 권하게 된다. 그 지시는 아직 큐에 남아 있을 수 있다 — 도는 턴의 중지와 같은 규율로
  // 판정의 부재는 재연결·재시도로 말한다.
  it("tells the user to reconnect when the cancel never reached the server", async () => {
    cancelOutcome = "unreachable";
    mount({ turnRunning: true, queue: [{ id: "q1", text: "first" }] });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".agent-chat-composer-queue-cancel")?.click();
    });
    const notice = container?.querySelector(".agent-chat-composer-error");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("Reconnect and try again");
    expect(notice?.textContent).not.toContain("already started");
  });

  // 중지는 포인터와 키보드 두 길을 함께 진다. Esc는 프레임 안에서만 듣는다 — 문서 전역에 걸면
  // 한 화면에 열린 다른 채팅 패널의 턴까지 끊는다.
  it("stops the running turn from Escape inside the frame, and only while it runs", async () => {
    mount({ turnRunning: true });
    const field = input();
    await act(async () => {
      field?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(stops).toBe(1);

    // 도는 턴이 없으면 Esc는 아무것도 끊지 않는다 — 끊을 것이 없는데 멈춤을 그리지 않기 위해서다.
    mount({ turnRunning: false });
    await act(async () => {
      input()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(stops).toBe(1);
  });

  // Quick Launch와 같은 `ultracode` 무장을 이 컴포저도 진다 — 같은 부품(sdk/composer)이
  // 인식·미러 문법을 소유하고, 표식만 이 조립이 싣는다.
  /** 같은 트리에 프롭만 갈아 끼운다. 다시 마운트하면 어차피 새로 읽으므로 검사가 무의미해진다. */
  function rerender(options: MountOptions): void {
    act(() => { root?.render(createElement(AgentChatComposer, composerProps(options))); });
  }

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

  describe("Console-owned slash commands", () => {
    const CATALOG: AgentChatCatalog = {
      commands: [
        { name: "clear", description: "Start a new session with empty context", argumentHint: "", console: "clear" },
        { name: "compact", description: "Free up context by summarizing", argumentHint: "" },
        { name: "context", description: "Show current context usage", argumentHint: "", console: "context" },
        { name: "reload-skills", description: "Pick up skills changed on disk", argumentHint: "" },
      ],
      skills: [],
      agents: [],
      unclassified: [],
    };

    /**
     * 덱을 한 번 열어 카탈로그를 받아 둔다 — 라우팅은 카탈로그를 알아야 깨어난다.
     * 덱은 포커스가 있을 때만 서므로(다른 표면이 포커스를 가져간 뒤 눌어붙지 않게 한 규칙)
     * 실제 사용자처럼 먼저 필드에 들어간다.
     */
    async function primeCatalog(): Promise<void> {
      catalogPayload = CATALOG;
      await act(async () => { input()?.focus(); });
      await act(async () => { type("/"); });
      await act(async () => {});
      if (container?.querySelector(".agent-chat-deck") === null) throw new Error("deck never opened");
    }

    function submit(): void {
      const field = input();
      field?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }

    /**
     * 이름을 정확히 친 직후에는 덱이 그 행을 세우고 있고, 그때의 Enter는 **완성**이다(승인된
     * 계약: 같은 Enter가 행마다 다른 일을 하지 않는다). 완성이 끝나면 문면 뒤에 공백이 붙어
     * 덱이 눕고, 그다음 Enter가 비로소 보내기다. 사용자가 실제로 밟는 순서를 그대로 밟는다.
     */
    async function completeThenSubmit(): Promise<void> {
      await act(async () => { submit(); });
      expect(container?.querySelector(".agent-chat-deck")).toBeNull();
      await act(async () => { submit(); });
    }




    it("opens the context meter instead of asking the child", async () => {
      mount();
      await primeCatalog();
      await act(async () => { type("/context"); });
      await completeThenSubmit();
      expect(meterOpens).toBe(1);
      expect(messages).toEqual([]);
    });


    it("arms /clear once and only sends on the second press", async () => {
      mount();
      await primeCatalog();
      await act(async () => { type("/clear"); });
      await completeThenSubmit();
      // 되돌릴 수 없는 절단이다 — 완성 뒤 첫 Enter는 확인이지 실행이 아니다.
      expect(messages).toEqual([]);
      expect(container?.textContent).toContain("Press Enter again");
      await act(async () => { submit(); });
      expect(messages).toEqual(["/clear"]);
    });

    it("disarms /clear when the draft changes", async () => {
      mount();
      await primeCatalog();
      await act(async () => { type("/clear"); });
      await completeThenSubmit();
      // 무장이 남아 있으면 다른 문면을 친 Enter가 `/clear`로 나간다.
      await act(async () => { type("/compact tighten"); });
      await act(async () => { submit(); });
      expect(messages).toEqual(["/compact tighten"]);
    });

    it("still sends a passthrough command to the child", async () => {
      mount();
      await primeCatalog();
      await act(async () => { type("/compact tighten it"); });
      await act(async () => { submit(); });
      expect(messages).toEqual(["/compact tighten it"]);
    });

    it("sends everything while the catalog is unknown", async () => {
      // 카탈로그를 모르는 동안 가로채면, 분류를 아직 모르는 지시가 자식에게 닿지 못한 채 삼켜진다.
      catalogPayload = null;
      mount();
      await act(async () => { type("/context"); });
      await act(async () => { submit(); });
      expect(meterOpens).toBe(0);
      expect(messages).toEqual(["/context"]);
    });
  });

  describe("catalog freshness", () => {
    const CATALOG2: AgentChatCatalog = {
      commands: [{ name: "reload-skills", description: "Pick up skills changed on disk", argumentHint: "" }],
      skills: [],
      agents: [],
      unclassified: [],
    };

    it("re-reads the catalog after a skill reload advances the epoch", async () => {
      // 서버가 자기 캐시를 버려도 이 사본은 마운트 내내 살아 있다 — 만료 좌표가 없으면 방금
      // 추가한 스킬이 패널을 다시 세울 때까지 보이지 않는다.
      catalogPayload = CATALOG2;
      mount();
      await act(async () => { input()?.focus(); });
      await act(async () => { type("/"); });
      await act(async () => {});
      expect(catalogFetches).toBe(1);

      // 같은 판본에서 덱을 닫았다 열어도 다시 읽지 않는다.
      await act(async () => { type(""); });
      await act(async () => { type("/"); });
      await act(async () => {});
      expect(catalogFetches).toBe(1);

      rerender({ catalogEpoch: 1 });
      await act(async () => {});
      expect(catalogFetches).toBe(2);
    });

    /**
     * 리뷰(#941 2차 P2)가 지목한 경로. 판본을 요청 **전에** 적으면, 그 요청이 빈손으로 돌아왔을
     * 때(404·409는 이 API의 정상 응답이다) 옛 사본이 새 판본의 것으로 둔갑해 다시 물어볼 길이
     * 사라진다.
     */
    it("keeps retrying when the refresh comes back empty", async () => {
      catalogPayload = CATALOG2;
      mount();
      await act(async () => { input()?.focus(); });
      await act(async () => { type("/"); });
      await act(async () => {});
      expect(catalogFetches).toBe(1);

      // 재읽기가 빈손으로 돌아온다 — 서버가 아직 세션을 세우는 중이거나 접는 중이다.
      catalogPayload = null;
      rerender({ catalogEpoch: 1 });
      await act(async () => {});
      expect(catalogFetches).toBe(2);

      // 덱을 닫았다 다시 열면 또 물어야 한다. 판본이 옛 사본에 붙어 버렸다면 여기서 멈춘다.
      catalogPayload = CATALOG2;
      await act(async () => { type(""); });
      await act(async () => { type("/"); });
      await act(async () => {});
      expect(catalogFetches).toBe(3);
    });
  });
});
