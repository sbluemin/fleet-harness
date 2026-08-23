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
    errorCode: null,
    jobs,
    context: null,
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

function render(): void {
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language: "en",
    operation: { id: "op-1", theaterId: "theater-1", type: "agent", pluginId: "terminal", title: "op", payload: {}, geometry: null, ts: { createdAt: 0, updatedAt: 0 } },
    runtimeState: { lifecycle: "live", activity: "idle" },
  } as unknown as OperationRenderContext;
  act(() => root?.render(createElement(AgentChatView, {
    context,
    tourAnchors: false,
  })));
}

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
}

// 백그라운드 작업의 문 — 이제 컴포저 툴 행(attach 왼쪽)의 글리프다. 떠 있던 스트립을 대신한다.
function strip(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>(".agent-chat-composer-work") ?? null;
}

function workPane(): HTMLElement | null {
  return container?.querySelector<HTMLElement>(".agent-chat-work") ?? null;
}

function logVisible(): boolean {
  const log = container?.querySelector(".agent-chat-log");
  return log !== null && log !== undefined && !log.hasAttribute("hidden");
}

describe("chat work surface", () => {
  it("stays out of the way until the session has background work", () => {
    mount();
    expect(strip()).toBeNull();
    expect(workPane()).toBeNull();
    expect(logVisible()).toBe(true);
  });

  it("opens the work pane beside the conversation, never instead of it", () => {
    // 이 표면의 요점 자체다. 탭은 대화를 통째로 숨겼는데, 백그라운드 작업은 대화를 대신하는 것이
    // 아니라 대화 옆에서 동시에 돈다 — 하나를 고르게 만들면 무엇이 도는지 보려고 무엇을 물었는지를 잃는다.
    logState = stateWith([job()]);
    mount();
    const door = strip();
    expect(door).not.toBeNull();
    act(() => { door?.click(); });

    expect(workPane()).not.toBeNull();
    expect(logVisible()).toBe(true);
  });

  it("keeps a door to the work surface after the last job settles", () => {
    // 글리프가 살아 있는 잡에만 서면, 마지막 잡이 끝나는 순간 지난 작업에 닿을 문이 사라진다.
    // 탭이 지던 몫이라 탭을 걷은 이상 쉬는 글리프(중립 정지 링)가 그 자리를 이어받아야 한다.
    logState = stateWith([job({ open: false, status: "completed" })]);
    mount();
    const door = strip();
    expect(door).not.toBeNull();
    // 정착만 남았으면 신호(도는 오브)가 아니라 중립 정지 링이 선다.
    expect(door?.querySelector(".agent-chat-composer-work-rest")).not.toBeNull();
    expect(door?.querySelector(".agent-chat-composer-work-orbit")).toBeNull();
    act(() => { door?.click(); });
    expect(workPane()).not.toBeNull();
  });

  it("keeps the collapse door when the job ledger resets underneath the open pane", () => {
    // 재접속이 리듀서를 되감고 저널에 잡 이벤트가 남아 있지 않으면 원장이 비어 버린다. 그때
    // 접는 문까지 사라지면 작업 면이 열린 채 굳는다.
    logState = stateWith([job()]);
    mount();
    act(() => { strip()?.click(); });
    expect(workPane()).not.toBeNull();

    logState = stateWith([]);
    render();

    const cap = container?.querySelector<HTMLButtonElement>(".agent-chat-work-cap");
    expect(cap).not.toBeNull();
    act(() => { cap?.click(); });
    expect(workPane()).toBeNull();
    expect(logVisible()).toBe(true);
  });
});

describe("chat work surface — panel controls", () => {
  it("exposes the splitter value and resizes the pane from the keyboard", () => {
    logState = stateWith([job()]);
    mount();
    act(() => { strip()?.click(); });

    const grip = container?.querySelector<HTMLElement>(".agent-chat-grip");
    expect(grip?.tabIndex).toBe(0);
    expect(grip?.getAttribute("aria-valuenow")).toBe("42");
    expect(grip?.getAttribute("aria-valuetext")).toBe("Background work pane 42%");

    act(() => { grip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(container?.querySelector(".agent-chat-grip")?.getAttribute("aria-valuenow")).toBe("46");

    act(() => { grip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(container?.querySelector(".agent-chat-grip")?.getAttribute("aria-valuenow")).toBe("18");
  });

  it("keeps no floating chip row in the body and leaves the composer with the conversation", () => {
    // 분석가·뷰 전환·읽기 폭은 캡션 밴드로 떠났다 — 본문 위에 떠 있던 그 줄이 남아 있으면
    // 작업 면이 열리는 순간 그 오른쪽 위로 넘어가 접기 컨트롤을 덮는다(실측으로 겪은 자리다).
    logState = stateWith([job()]);
    mount();
    act(() => { strip()?.click(); });
    expect(container?.querySelector(".agent-view-chip-row")).toBeNull();
    // 컴포저는 대화 면의 것이다 — 문맥 미터도 그 컨트롤 행에 실려 함께 남는다.
    const composer = container?.querySelector(".agent-chat-composer");
    expect(composer).not.toBeNull();
    expect(composer?.closest(".agent-chat-pane")).not.toBeNull();
    expect(composer?.closest(".agent-chat-work")).toBeNull();
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
    act(() => { strip()?.click(); });
    act(() => { container?.querySelector<HTMLButtonElement>(".agent-chat-work .agent-chat-job")?.click(); });

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
    act(() => { strip()?.click(); });
    act(() => { container?.querySelector<HTMLButtonElement>(".agent-chat-work .agent-chat-job")?.click(); });
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
    // 문은 그대로 열린다 — 몸(종류·소요·출력)은 작업 면의 것이다.
    act(() => { anchor?.click(); });
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
    expect(clauses.map((clause) => clause.querySelector(".agent-chat-tally-glyph")?.textContent))
      .toEqual(["▤", "❯", "⌕"]);
    // 셸은 잡 글리프(❯)와 같은 기호다 — 같은 일을 두 면이 다른 기호로 부르면 어휘가 아니라 장식이 된다.
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
    expect(running?.querySelector(".agent-chat-tally-glyph")?.textContent).toBe("❯");
    expect(running?.textContent).toContain("Running pnpm test");
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
    expect(clause?.querySelector(".agent-chat-tally-glyph")?.textContent).toBe("▪");
    // `other`는 도구 이름이 곧 주어다 — 표식이 그 이름을 밀어내지 않는다.
    expect(clause?.querySelector(".agent-chat-tally-name")?.textContent).toBe("mcp__fleet__wiki_read");
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
