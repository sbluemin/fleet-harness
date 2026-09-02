// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatJob, AgentChatLogState } from "./chat-events.js";

// 스트림 상태는 이 테스트가 직접 쥔다 — 재접속으로 원장이 되감기는 순간을 만들어야 하기 때문이다.
let logState: AgentChatLogState;

const detailCalls: string[] = [];

vi.mock("./chat-store.js", () => ({
  useAgentChatStream: () => ({
    ...logState,
    connection: "open",
    stopTurn: async () => {},
    answerAsk: async () => {},
  }),
}));
vi.mock("../api.js", () => ({
  readAgentChatJobDetail: async (_op: string, jobId: string) => {
    detailCalls.push(jobId);
    return null;
  },
}));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function job(overrides: Partial<AgentChatJob> = {}): AgentChatJob {
  return { id: "w1", kind: "workflow", title: "two-step", open: true, stages: [], ends: 0, ...overrides };
}

function stateWith(jobs: readonly AgentChatJob[]): AgentChatLogState {
  return {
    turns: [{ dispatch: { text: "go" }, items: [], state: "done", toolCount: 0, draft: "" }],
    replaying: false,
    snapshotting: false,
    observedTurns: 0,
    errorCode: null,
    jobs,
    context: null,
    queue: [],
    catalogEpoch: 0,
  };
}

beforeEach(() => {
  detailCalls.length = 0;
  logState = stateWith([]);
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

function render(activity: "idle" | "running" = "idle"): void {
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language: "en",
    operation: { id: "op-1", theaterId: "theater-1", type: "agent", pluginId: "terminal", title: "op", payload: {}, geometry: null, ts: { createdAt: 0, updatedAt: 0 } },
    runtimeState: { lifecycle: "live", activity },
  } as unknown as OperationRenderContext;
  act(() => root?.render(createElement(AgentChatView, {
    context,
    tourAnchors: false,
  })));
}

function mount(activity: "idle" | "running" = "idle"): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render(activity);
}

// 백그라운드 작업의 상태 버튼 — 스피너와 관련 문구 전체가 작업 면을 여닫는다.
function statusToggle(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>(".agent-chat-ledge-toggle") ?? null;
}

function workPane(): HTMLElement | null {
  return container?.querySelector<HTMLElement>(".agent-chat-sheet") ?? null;
}

function logVisible(): boolean {
  const log = container?.querySelector(".agent-chat-log");
  return log !== null && log !== undefined && !log.hasAttribute("hidden");
}

describe("chat work surface", () => {
  it("stays out of the way until the session has background work", () => {
    mount();
    expect(statusToggle()).toBeNull();
    expect(workPane()).toBeNull();
    expect(logVisible()).toBe(true);
  });

  it("opens the work sheet over the conversation, never instead of it", () => {
    // 이 표면의 요점 자체다. 탭은 대화를 통째로 숨겼는데, 백그라운드 작업은 대화를 대신하는 것이
    // 아니라 대화 옆에서 동시에 돈다 — 시트는 대화의 아래쪽을 덮을 뿐, 로그는 그대로 서 있다.
    logState = stateWith([job()]);
    mount();
    const toggle = statusToggle();
    expect(toggle).not.toBeNull();
    expect(toggle?.querySelector(".agent-chat-strip-orbit")).not.toBeNull();
    expect(toggle?.textContent).toContain("1 running");
    expect(toggle?.textContent).toContain("two-step");
    expect(toggle?.getAttribute("aria-label")).toBeNull();
    expect(toggle?.textContent).not.toContain("Show");
    expect(toggle?.textContent).not.toContain("Hide");
    act(() => { toggle?.click(); });

    expect(workPane()).not.toBeNull();
    expect(logVisible()).toBe(true);
    expect(statusToggle()?.getAttribute("aria-expanded")).toBe("true");
    act(() => { statusToggle()?.click(); });
    expect(workPane()).toBeNull();
    expect(statusToggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a door to the work surface after the last job settles", () => {
    // 선반이 살아 있는 잡에만 서면, 마지막 잡이 끝나는 순간 지난 작업에 닿을 문이 사라진다.
    // 정착만 남았으면 선반은 신호(도는 오브)가 아니라 중립 도트와 개수로 말한다.
    logState = stateWith([job({ open: false, status: "completed" })]);
    mount();
    const ledge = container?.querySelector(".agent-chat-ledge");
    expect(ledge?.classList.contains("is-rest")).toBe(true);
    expect(ledge?.querySelector(".agent-chat-strip-dot")).not.toBeNull();
    expect(ledge?.querySelector(".agent-chat-strip-orbit")).toBeNull();
    expect(ledge?.querySelector(".agent-chat-strip-count")?.textContent).toBe("1 job");
    act(() => { statusToggle()?.click(); });
    expect(workPane()).not.toBeNull();
  });

  it("closes the sheet when the job ledger resets underneath it", () => {
    // 재접속이 리듀서를 되감고 저널에 잡 이벤트가 남아 있지 않으면 원장이 비어 버린다. 선반은
    // 잡과 함께 물러나므로, 그때 시트가 남으면 문 없는 시트가 열린 채 굳는다.
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    expect(workPane()).not.toBeNull();

    logState = stateWith([]);
    render();

    expect(statusToggle()).toBeNull();
    expect(workPane()).toBeNull();
    expect(logVisible()).toBe(true);
  });
});

describe("chat work surface — panel controls", () => {
  it("moves focus into the opened sheet, then hides on Escape and returns focus to the status", () => {
    // 시트는 DOM에서 선반보다 앞에 있으므로 상태에 초점을 둔 채 열면 다음 Tab이 컴포저로 건너뛴다.
    // 보이는 첫 작업으로 초점을 보내고, Esc로 접으면 같은 자리의 상태 버튼으로 돌아온다.
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    expect(workPane()).not.toBeNull();
    expect(statusToggle()?.getAttribute("aria-controls")).toBe(workPane()?.id);
    const firstJob = workPane()?.querySelector<HTMLButtonElement>(".agent-chat-job");
    expect(document.activeElement).toBe(firstJob);

    act(() => { firstJob?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(workPane()).toBeNull();
    expect(statusToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(statusToggle()?.textContent).toContain("1 running");
    expect(statusToggle()?.textContent).not.toContain("Show");
    expect(statusToggle()?.textContent).not.toContain("Hide");
    expect(document.activeElement).toBe(statusToggle());
  });

  it("keeps focus inside the sheet when list and detail replace each other", () => {
    // 작업 카드와 상세의 뒤로 버튼은 뷰를 바꾸는 순간 스스로 사라진다. 새 뷰의 첫 컨트롤로
    // 초점을 이어야 Esc가 계속 이 패널에 귀속되고, Tab도 보이는 내용 안에서 시작한다.
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    const jobButton = workPane()?.querySelector<HTMLButtonElement>(".agent-chat-job");

    act(() => { jobButton?.click(); });

    const back = workPane()?.querySelector<HTMLButtonElement>(".agent-chat-detail-back");
    expect(back).not.toBeNull();
    expect(document.activeElement).toBe(back);

    act(() => { back?.click(); });

    const returnedJob = workPane()?.querySelector<HTMLButtonElement>(".agent-chat-job");
    expect(document.activeElement).toBe(returnedJob);
  });

  it("lets a child control consume Escape before the sheet", () => {
    // 컴포저 덱은 시트보다 위의 열린 표면이다. 자식이 Esc를 소비하면 패널의 bubble 핸들러까지
    // 오지 않아 시트는 그대로 남는다 — capture 단계에서는 이 위계를 뒤집는다.
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    const input = container?.querySelector<HTMLTextAreaElement>(".agent-chat-composer-input");
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { once: true });
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

    act(() => { input?.dispatchEvent(escape); });

    expect(workPane()).not.toBeNull();
    expect(escape.defaultPrevented).toBe(true);
  });

  it("ignores Escape during IME composition", () => {
    // 조합 중 Esc는 입력기 소유다. 컴포저와 같은 경계로 시트도 듣지 않는다.
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    const input = container?.querySelector<HTMLTextAreaElement>(".agent-chat-composer-input");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });

    act(() => { input?.dispatchEvent(escape); });

    expect(workPane()).not.toBeNull();
    expect(escape.defaultPrevented).toBe(false);
  });

  it("does not consume Escape from outside this chat panel", () => {
    // 한 화면에 채팅 패널이 여럿 산다. document 캡처 리스너를 쓰면 다른 패널의 컴포저가 보낸
    // Esc까지 먼저 삼켜 이 시트를 접고, 열린 시트가 여럿이면 전부 함께 접힌다.
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    const outside = document.createElement("button");
    document.body.append(outside);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

    act(() => { outside.dispatchEvent(escape); });

    expect(workPane()).not.toBeNull();
    expect(escape.defaultPrevented).toBe(false);
    outside.remove();
  });

  it("hides on a pointer-down on the conversation", () => {
    // 시트가 덮지 않은 대화 위를 누르면 물러난다 — 콘솔의 팝오버와 같은 문법이다.
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    expect(workPane()).not.toBeNull();

    act(() => { container?.querySelector(".agent-chat-log")?.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(workPane()).toBeNull();
  });

  it("keeps no floating chip row in the body and leaves the composer with the conversation", () => {
    // 분석가·뷰 전환·읽기 폭은 캡션 밴드로 떠났다 — 본문 위에 떠 있던 그 줄이 남아 있으면
    // 작업 면이 열리는 순간 그 오른쪽 위로 넘어가 접기 컨트롤을 덮는다(실측으로 겪은 자리다).
    logState = stateWith([job()]);
    mount();
    act(() => { statusToggle()?.click(); });
    expect(container?.querySelector(".agent-view-chip-row")).toBeNull();
    // 컴포저는 대화 면의 것이다 — 문맥 미터도 그 컨트롤 행에 실려 함께 남는다.
    const composer = container?.querySelector(".agent-chat-composer");
    expect(composer).not.toBeNull();
    expect(composer?.closest(".agent-chat-pane")).not.toBeNull();
    expect(composer?.closest(".agent-chat-sheet")).toBeNull();
    // 선반은 컴포저 바로 위, 같은 대화 면 안에 in-flow로 선다.
    const ledge = container?.querySelector(".agent-chat-ledge");
    expect(ledge?.nextElementSibling).toBe(composer);
  });
});

describe("chat work surface — log padding", () => {
  it("gives the log one bottom margin, whatever the strip is doing", () => {
    // 스트립이 회신 버튼과 같은 행으로 내려오면서 그 높이는 로그의 기본 바닥 여백 안에 들어왔다.
    // 잡의 유무로 여백이 달라지면 그만큼이 죽은 띠로 남고, 잡이 끝나는 순간 로그가 한 번 튄다.
    for (const settled of [false, true]) {
      logState = stateWith([job(settled ? { open: false, status: "completed" } : {})]);
      mount();
      expect(container?.querySelector(".agent-chat-log")?.className).toBe("agent-chat-log");
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    }
  });
});

describe("chat work surface — stage identities", () => {
  it("shows a gateway model by its own name, keeping the routed id within reach", () => {
    // 게이트웨이 별칭은 이 모델이 어디로 실려 갔는지만 말한다. 표의 모든 행이 같은 앞자리로
    // 시작하면 좁은 칸에서 정작 다른 부분이 먼저 말줄임에 잘려, 어느 모델이었는지가 사라진다.
    logState = stateWith([job({
      open: false,
      status: "completed",
      ends: 1,
      stages: [{
        title: "Propose",
        agents: [
          { label: "propose:sol", model: "claude-gateway--codex--gpt-5.6-sol", state: "done" },
          { label: "judge:opus", model: "claude-opus-5[1m]", state: "done" },
        ],
      }],
    })]);
    mount();
    act(() => { statusToggle()?.click(); });
    act(() => { container?.querySelector<HTMLButtonElement>(".agent-chat-sheet .agent-chat-job")?.click(); });

    const cells = [...(container?.querySelectorAll<HTMLElement>(".agent-chat-stage-row .is-model") ?? [])];
    expect(cells.map((cell) => cell.textContent)).toEqual(["codex--gpt-5.6-sol", "claude-opus-5[1m]"]);
    // 잘린 이름을 되찾을 자리는 남긴다 — 표시형이 원본을 지우지는 않는다.
    expect(cells[0]?.getAttribute("title")).toBe("claude-gateway--codex--gpt-5.6-sol");
  });
});

describe("chat work surface — job detail timing", () => {
  it("asks again when the outcome lands after the job already closed", async () => {
    // 백그라운드 셸은 task_updated(killed)가 먼저 닫고, 출력 파일의 좌표는 그 뒤 task_notification이
    // 들고 온다(실측 순서). 상세를 열어 둔 채 잡이 끝나면 첫 요청이 좌표보다 먼저 도착해 빈손으로
    // 돌아오는데, 다시 묻지 않으면 "기록 없음"이 영영 굳는다.
    //
    // 그 알림은 **status만** 실어 올 수 있다(매퍼가 허용하는 형태다). 그래서 여기서도 요약도
    // 소요 시간도 더하지 않고 도착 횟수만 올린다 — 내용으로 도착을 추론하는 구현은 여기서 죽는다.
    const closed = { id: "b1", kind: "shell" as const, title: "loop", open: false, status: "stopped" as const, stages: [], ends: 1 };
    logState = { ...stateWith([closed]), jobs: [closed] };
    mount();
    act(() => { statusToggle()?.click(); });
    act(() => { container?.querySelector<HTMLButtonElement>(".agent-chat-sheet .agent-chat-job")?.click(); });
    await act(async () => { await Promise.resolve(); });
    const first = detailCalls.length;
    expect(first).toBeGreaterThan(0);

    // 결말 보고가 도착한다 — 잡은 이미 닫혀 있었고 id도 그대로다.
    const reported = { ...closed, ends: closed.ends + 1 };
    logState = { ...stateWith([reported]), jobs: [reported] };
    render();
    await act(async () => { await Promise.resolve(); });
    expect(detailCalls.length).toBeGreaterThan(first);
  });
});

/**
 * 원장은 읽는 면이다.
 *
 * 그 면을 잃는 길은 두 가지였다. 하나는 도는 동안 최근 도구 호출을 전폭 행으로 세워 두는 것
 * (실측: 로그 가시 영역의 58%), 다른 하나는 백그라운드 잡마다 두 줄짜리 카드를 원장 한가운데
 * 세우는 것이었다. 둘 다 같은 자리를 놓고 모델의 문장과 다툰다.
 */
describe("chat ledger — one live line, and a job anchor instead of a card", () => {
  const readStep = (detail: string) => ({ type: "tool" as const, name: "Read", detail, state: "ok" as const });

  function workingTurn(items: readonly unknown[]): AgentChatLogState {
    return {
      ...stateWith([]),
      turns: [{
        dispatch: { text: "go" },
        items: items as AgentChatLogState["turns"][number]["items"],
        state: "working",
        toolCount: items.length,
        draft: "",
      }],
    };
  }

  it("folds a running segment into one line instead of stacking tool rows", () => {
    logState = workingTurn([
      { type: "text", text: "Reading the folder." },
      readStep("alpha.md"), readStep("beta.md"), readStep("gamma.md"),
      readStep("delta.md"), readStep("epsilon.md"), readStep("zeta.md"),
      { type: "tool", name: "Read", detail: "eta.md", state: "running" },
    ]);
    mount();
    // 끝난 여섯 건은 집계 한 줄로 접히고, 세워지는 줄은 그 하나뿐이다.
    const live = container?.querySelector(".agent-chat-tally.is-live");
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain("Read 6 files");
    // 지금 도는 것은 그 줄의 꼬리가 말한다 — 자기 행을 따로 세우지 않는다.
    expect(live?.textContent).toContain("Reading eta.md");
    // 접힘 안의 행은 DOM에 남지만 닫힌 <details> 뒤에 있다 — 구간에 **세워진** 행이 0이다.
    expect(container?.querySelectorAll(".agent-chat-segment > .agent-chat-step").length).toBe(0);
    // 그리고 그 줄은 스스로 살아 있다고 말한다: 링 하나와 좌→우 물결.
    expect(live?.querySelector(".agent-chat-step-orbit")).not.toBeNull();
    expect(live?.querySelector(".agent-chat-live-text")).not.toBeNull();
  });

  it("keeps the folded steps reachable behind the live line", () => {
    logState = workingTurn([
      { type: "text", text: "Reading the folder." },
      readStep("alpha.md"), readStep("beta.md"),
      { type: "tool", name: "Read", detail: "gamma.md", state: "running" },
    ]);
    mount();
    // 접힌 것은 감춘 것이 아니다 — 도는 줄도 누르면 자기가 센 스텝을 순서대로 편다.
    const fold = container?.querySelector<HTMLDetailsElement>(".agent-chat-tally-fold");
    expect(fold).not.toBeNull();
    act(() => { fold?.setAttribute("open", ""); });
    const rows = [...(fold?.querySelectorAll(".agent-chat-tally-body .agent-chat-step") ?? [])];
    // 도는 스텝까지 함께 든다 — 요약 줄이 그것을 셌으므로 펼침에서 빠지면 셈이 맞지 않는다.
    expect(rows.map((row) => row.textContent)).toHaveLength(3);
  });

  it("leaves a background job as one anchor line where it was born, not a card", () => {
    logState = {
      ...stateWith([job({ id: "j1", kind: "shell", title: "sleep 300", open: true })]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Reading, then delegating." },
          readStep("alpha.md"),
          { type: "tool", name: "Bash", detail: "sleep 300", id: "call-1", state: "ok" },
          readStep("beta.md"),
        ] as AgentChatLogState["turns"][number]["items"],
        state: "done",
        toolCount: 3,
        draft: "",
      }],
      jobs: [job({ id: "j1", kind: "shell", title: "sleep 300", open: true })],
    };
    // 잡은 도구 호출 id로 원장에 붙는다.
    logState = { ...logState, jobs: [{ ...logState.jobs[0]!, toolUseId: "call-1" }] };
    mount();
    // 원장에는 카드가 아니라 한 줄이 선다.
    expect(container?.querySelector(".agent-chat-ledger .agent-chat-job")).toBeNull();
    const anchor = container?.querySelector<HTMLButtonElement>(".agent-chat-job-anchor");
    expect(anchor).not.toBeNull();
    // 그리고 그 줄은 태어난 자리를 지킨다 — 앞뒤 집계가 그 자리에서 갈린다.
    const segment = container?.querySelector(".agent-chat-segment");
    const kinds = [...(segment?.children ?? [])]
      .map((child) => (child.classList.contains("agent-chat-ledger-note")
        ? "note"
        : child.classList.contains("agent-chat-job-anchor") ? "job" : "tally"));
    expect(kinds).toEqual(["note", "tally", "job", "tally"]);
    // 문은 그대로 열린다 — 몸(종류·소요·출력)은 시트의 것이다.
    act(() => { anchor?.click(); });
    expect(workPane()).not.toBeNull();
    // 앵커 위의 pointer-down은 시트를 닫지 않는다 — 여는 문이 스스로를 지우면 안 된다.
    act(() => { anchor?.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(workPane()).not.toBeNull();
  });
});

/**
 * 계열 표식 — 집계 줄은 절이 이어질수록 한 줄짜리 글자 덩어리가 된다. 표식이 절 앞에 서면
 * 무엇이 몇 건인지 세는 일이 읽기가 아니라 훑기가 된다.
 */
describe("chat ledger — family glyphs on the tally clauses", () => {
  it("marks every clause with its family, and shares the job glyph alphabet", () => {
    logState = {
      ...stateWith([]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Looking around." },
          { type: "tool", name: "Read", detail: "alpha.md", state: "ok" },
          { type: "tool", name: "Bash", detail: "ls", state: "ok" },
          { type: "tool", name: "Grep", detail: "needle", state: "ok" },
        ] as AgentChatLogState["turns"][number]["items"],
        state: "done",
        toolCount: 3,
        draft: "",
      }],
    };
    mount();
    const clauses = [...(container?.querySelectorAll(".agent-chat-tally-clause") ?? [])];
    expect(clauses).toHaveLength(3);
    // 표식은 모노라인 SVG 알파벳이다 — 문자가 아니라 계열 이름이 곧 글자다.
    expect(clauses.map((clause) => clause.querySelector(".agent-chat-tally-glyph svg")?.getAttribute("data-glyph")))
      .toEqual(["read", "run", "search"]);
    // 셸은 잡 글리프(run)와 같은 글자다 — 같은 일을 두 면이 다른 기호로 부르면 어휘가 아니라 장식이 된다.
    expect(clauses[1]?.textContent).toContain("Ran 1 shell command");
  });

  it("marks the running clause too, so the live line reads the same way", () => {
    logState = {
      ...stateWith([]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Working." },
          { type: "tool", name: "Read", detail: "alpha.md", state: "ok" },
          { type: "tool", name: "Bash", detail: "pnpm test", state: "running" },
        ] as AgentChatLogState["turns"][number]["items"],
        state: "working",
        toolCount: 2,
        draft: "",
      }],
    };
    mount();
    const live = container?.querySelector(".agent-chat-tally.is-live");
    const running = live?.querySelector(".agent-chat-tally-running .agent-chat-tally-clause");
    expect(running?.querySelector(".agent-chat-tally-glyph svg")?.getAttribute("data-glyph")).toBe("run");
    expect(running?.textContent).toContain("Running pnpm test");
    // 상세 기록에는 정적 도구 글리프가 서고 두 번째 orbit은 없다.
    expect(live?.parentElement?.querySelector(".agent-chat-tally-body .agent-chat-step-mark.is-running svg")?.getAttribute("data-glyph")).toBe("run");
    expect(container?.querySelectorAll(".agent-chat-step-orbit")).toHaveLength(1);
  });

  it("falls back to the neutral mark for a tool with no family", () => {
    logState = {
      ...stateWith([]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Calling out." },
          { type: "tool", name: "mcp__fleet__wiki_read", detail: "page", state: "ok" },
        ] as AgentChatLogState["turns"][number]["items"],
        state: "done",
        toolCount: 1,
        draft: "",
      }],
    };
    mount();
    const clause = container?.querySelector(".agent-chat-tally-clause");
    expect(clause?.querySelector(".agent-chat-tally-glyph svg")?.getAttribute("data-glyph")).toBe("other");
    // `other`는 도구 이름이 곧 주어다 — 표식이 그 이름을 밀어내지 않는다.
    expect(clause?.querySelector(".agent-chat-tally-name")?.textContent).toBe("mcp__fleet__wiki_read");
  });
});

/**
 * 살아 있는 줄은 턴에 하나다. "생각 중…"은 상자가 아니라 그 줄의 꼬리이고, 링은 꼬리가
 * 무엇인가를 말할 때만 산다 — 글자가 흐르는 동안은 꼬리가 비고 생명은 글 끝의 캐럿이 진다.
 * 예전에는 도는 턴의 집계 줄이 무조건 링을 달고, 그 아래 생각 상자가 링을 하나 더 달았다
 * (실측: 링 2개, 애니메이션 6개가 동시에).
 */
describe("chat ledger — one live line", () => {
  function workingWith(items: readonly unknown[], draft = ""): AgentChatLogState {
    return {
      ...stateWith([]),
      turns: [{
        dispatch: { text: "go" },
        items: items as AgentChatLogState["turns"][number]["items"],
        state: "working",
        toolCount: items.length,
        draft,
        startedAt: Date.now() - 34_000,
      }],
    };
  }
  it("says Thinking in the tail of the live tally instead of standing a boxed step", () => {
    logState = workingWith([
      { type: "text", text: "Reading the folder." },
      { type: "tool", name: "Read", detail: "package.json", state: "ok" },
      { type: "tool", name: "Bash", detail: "pnpm build", state: "ok" },
    ]);
    mount("running");
    const live = container?.querySelector(".agent-chat-tally.is-live");
    expect(live?.querySelector(".agent-chat-tally-running")?.textContent).toContain("Thinking…");
    expect(live?.querySelector(".agent-chat-tally-running svg")?.getAttribute("data-glyph")).toBe("think");
    // 상자도, 두 번째 링도 없다.
    expect(container?.querySelector(".agent-chat-step.is-running")).toBeNull();
    expect(container?.querySelectorAll(".agent-chat-step-orbit")).toHaveLength(1);
    // 헤드의 시계는 물결을 지지 않는다.
    expect(container?.querySelector(".agent-chat-turn-head .agent-chat-live-text")).toBeNull();
    expect(container?.querySelector(".agent-chat-turn-clock")?.textContent).toContain("Working…");
  });

  it("stands a bare Thinking line for the first gap before any step", () => {
    logState = workingWith([]);
    mount("running");
    const live = container?.querySelector(".agent-chat-tally.is-live");
    expect(live?.textContent).toContain("Thinking…");
    expect(container?.querySelectorAll(".agent-chat-step-orbit")).toHaveLength(1);
    // 셀 것이 없으니 펼침도 없다 — 열쇠 없는 자물쇠는 어포던스가 아니다.
    expect(container?.querySelector(".agent-chat-tally-fold")).toBeNull();
  });

  it("rests the tally while the answer streams, and marks the streaming text instead", () => {
    logState = workingWith([
      { type: "text", text: "Reading the folder." },
      { type: "tool", name: "Read", detail: "package.json", state: "ok" },
    ], "The build is fine");
    mount("running");
    expect(container?.querySelector(".agent-chat-tally.is-live")).toBeNull();
    expect(container?.querySelectorAll(".agent-chat-step-orbit")).toHaveLength(0);
    expect(container?.querySelector(".agent-chat-stream.is-streaming")).not.toBeNull();
    expect(container?.querySelector(".agent-chat-tally")?.textContent).not.toContain("Thinking");
  });

  it("folds a thought trace into the tally as time, not as a count", () => {
    logState = {
      ...stateWith([]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Reading the folder." },
          { type: "tool", name: "Read", detail: "package.json", state: "ok" },
          { type: "thought", durationMs: 3_400 },
          { type: "tool", name: "Bash", detail: "pnpm build", state: "ok" },
          { type: "thought", durationMs: 2_100 },
        ] as AgentChatLogState["turns"][number]["items"],
        state: "done",
        toolCount: 2,
        draft: "",
      }],
    };
    mount();
    const clauses = [...(container?.querySelectorAll(".agent-chat-tally-clause") ?? [])].map((clause) => clause.textContent);
    expect(clauses).toEqual(["Read 1 file", "Thought for 6s", "Ran 1 shell command"]);
    // 생각은 집계 절 자체가 전부다 — 펼침 본문에 빈 전폭 스텝 상자로 반복하지 않는다.
    expect(container?.querySelector(".agent-chat-step.is-thought")).toBeNull();
  });
});

/**
 * 병렬 도구 배치 — 한 assistant 메시지가 tool_use 블록을 여럿 실은 경우다. 그 스텝들은 다음
 * 사용자 메시지가 결과를 실어 올 때까지 **동시에** running으로 남으므로, 꼬리 하나만 라이브 줄로
 * 걷으면 나머지가 그대로 전폭 행으로 선다 — 배치가 클수록 한 줄 원장이 무너진다.
 */
describe("chat ledger — a parallel tool batch", () => {
  it("folds every concurrently running step into the one live line", () => {
    logState = {
      ...stateWith([]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Reading four files at once." },
          { type: "tool", name: "Read", detail: "alpha.md", state: "ok" },
          { type: "tool", name: "Read", detail: "beta.md", state: "running" },
          { type: "tool", name: "Read", detail: "gamma.md", state: "running" },
          { type: "tool", name: "Grep", detail: "notes", state: "running" },
        ] as AgentChatLogState["turns"][number]["items"],
        state: "working",
        toolCount: 4,
        draft: "",
      }],
    };
    mount();
    expect(container?.querySelectorAll(".agent-chat-segment > .agent-chat-step").length).toBe(0);
    const live = container?.querySelector(".agent-chat-tally.is-live");
    expect(live?.textContent).toContain("Reading beta.md");
    expect(live?.textContent).toContain("Reading gamma.md");
    expect(live?.textContent).toContain("Searching notes");
  });
});

/**
 * 배치 안에 백그라운드 잡이 섞인 경우. 잡 앵커는 태어난 자리를 지켜야 하고(그것이 이 원장의
 * 계약이다), 그 앞에서 아직 도는 스텝은 여전히 라이브 줄로 걷혀야 한다 — 앵커 하나가 사이에
 * 끼었다는 이유로 도는 스텝이 자기 행을 되찾으면 안 된다.
 */
describe("chat ledger — a batch that also starts a background job", () => {
  it("keeps the anchor in place and still folds the running step into the live line", () => {
    const running = { id: "j2", kind: "shell" as const, title: "sleep 300", open: true, stages: [], ends: 0, toolUseId: "call-bg" };
    logState = {
      ...stateWith([running]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Reading and delegating at once." },
          { type: "tool", name: "Read", detail: "alpha.md", state: "ok" },
          { type: "tool", name: "Read", detail: "beta.md", state: "running" },
          { type: "tool", name: "Bash", detail: "sleep 300", id: "call-bg", state: "ok" },
        ] as AgentChatLogState["turns"][number]["items"],
        state: "working",
        toolCount: 3,
        draft: "",
      }],
      jobs: [running],
    };
    mount();
    expect(container?.querySelectorAll(".agent-chat-segment > .agent-chat-step").length).toBe(0);
    expect(container?.querySelector(".agent-chat-job-anchor")).not.toBeNull();
    const live = container?.querySelector(".agent-chat-tally.is-live");
    expect(live?.textContent).toContain("Reading beta.md");
  });

  it("names the delegated task in the anchor, not just its agent type", () => {
    // 카드가 제목 자리에 쓰던 값 그대로다. subagent_type만 남기면 위임 여러 건이
    // "◆ general-purpose"로 똑같아져, 어느 것이 무엇인지 열어 봐야만 알 수 있다.
    const delegated = { id: "j3", kind: "agent" as const, title: "Audit the gateway roster", who: "general-purpose", open: true, stages: [], ends: 0, toolUseId: "call-task" };
    logState = {
      ...stateWith([delegated]),
      turns: [{
        dispatch: { text: "go" },
        items: [
          { type: "text", text: "Delegating." },
          { type: "tool", name: "Task", detail: "audit", id: "call-task", state: "ok" },
        ] as AgentChatLogState["turns"][number]["items"],
        state: "done",
        toolCount: 1,
        draft: "",
      }],
      jobs: [delegated],
    };
    mount();
    const anchor = container?.querySelector(".agent-chat-job-anchor");
    expect(anchor?.textContent).toContain("Audit the gateway roster");
  });
});
