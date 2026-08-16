import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentChatAskFromToolInput, type AgentChatJournalEvent } from "../server/agent-api/chat-events.js";
import { AgentChatRegistry, type AgentChatSessionSeed } from "../server/agent-api/chat-session.js";

/**
 * 대화형 도구 왕복의 계약.
 *
 * 실측(SDK 0.3.212)이 고정한 사실 위에 선다: `canUseTool`을 주면 자식이 `AskUserQuestion`·
 * `ExitPlanMode`를 갖고, 답변은 그 콜백의 반환으로만 자식에게 닿는다. 질문은
 * `updatedInput.answers`로, 계획은 allow 자체가 승인이며, deny의 message는 계획 쪽에서
 * 수정 요청이 되어 모델이 계획을 고쳐 다시 낸다.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

type CanUseTool = (
  name: string,
  input: Readonly<Record<string, unknown>>,
  context: { readonly toolUseId: string; readonly signal: AbortSignal },
) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }>;

/**
 * 턴이 시작되면 그 자리에 멈춰 있는 가짜 SDK. 스트림을 열어 둔 채로 `canUseTool`을 노출해,
 * 실제 자식이 도구를 부르는 순간을 테스트가 직접 재현한다.
 */
function createPausedSdkFactory() {
  const configDir = tempDir("chat-ask-sdk-");
  let canUseTool: CanUseTool | null = null;
  let release: (() => void) | null = null;
  const startTurn = vi.fn(async (turn: Record<string, unknown>) => {
    canUseTool = turn.canUseTool as CanUseTool;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return {
      close: vi.fn(() => { release?.(); }),
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (done) return { done: true as const, value: undefined };
            await gate;
            done = true;
            return { done: false as const, value: { type: "result", subtype: "success", is_error: false, duration_ms: 5 } };
          },
        };
      },
    };
  });
  return {
    factory: (async ({ models }: { readonly models: readonly string[] }) => ({
      configDir,
      models,
      startTurn,
      // 실제 SDK의 dispose는 활성 런을 끊는다. 그것을 흉내 내지 않으면 스트림이 끝나지 않아
      // 테스트가 제품 코드 대신 픽스처에서 매달린다.
      dispose: vi.fn(async () => { release?.(); }),
    })) as never,
    startTurn,
    ask: (name: string, input: Record<string, unknown>, toolUseId = "tool-1") => {
      if (!canUseTool) throw new Error("the turn has not started yet");
      return canUseTool(name, input, { toolUseId, signal: new AbortController().signal });
    },
    /** 신호를 직접 건네는 갈래 — 이미 끊긴 턴을 재현할 때 쓴다. */
    askWith: (name: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal) => {
      if (!canUseTool) throw new Error("the turn has not started yet");
      return canUseTool(name, input, { toolUseId, signal });
    },
    finish: () => { release?.(); },
  };
}

function seedFor(awaitingLog: boolean[]): AgentChatSessionSeed {
  return {
    baseUrl: "http://127.0.0.1:9/gateway",
    model: "opus[1m]",
    cwd: "/tmp/workspace",
    origin: { kind: "fresh", transcriptRoot: tempDir("chat-ask-root-") },
    onProviderSessionUpdate: () => {},
    reportActivity: () => true,
    canReportActivity: () => true,
    reportAwaiting: (awaiting) => { awaitingLog.push(awaiting); },
  };
}

const QUESTION_INPUT = {
  questions: [{
    question: "Should logs be JSON or plain text?",
    header: "Log format",
    multiSelect: false,
    options: [
      { label: "JSON", description: "Structured logs" },
      { label: "Plain text", description: "Human-readable logs" },
    ],
  }],
};

async function startSession(registry: AgentChatRegistry, sdk: ReturnType<typeof createPausedSdkFactory>, awaitingLog: boolean[]) {
  const session = await registry.ensure("op-ask", () => seedFor(awaitingLog));
  const events: AgentChatJournalEvent[] = [];
  session.subscribe((entry) => events.push(entry));
  session.send("decide the log format");
  await vi.waitFor(() => { expect(sdk.startTurn).toHaveBeenCalled(); });
  return { session, events };
}

describe("agentChatAskFromToolInput", () => {
  it("reads a question with its options", () => {
    const parsed = agentChatAskFromToolInput("AskUserQuestion", "id-1", QUESTION_INPUT);
    expect(parsed).toEqual({
      event: {
        kind: "ask",
        id: "id-1",
        form: "question",
        questions: [{
          header: "Log format",
          question: "Should logs be JSON or plain text?",
          multiSelect: false,
          options: [
            { label: "JSON", description: "Structured logs" },
            { label: "Plain text", description: "Human-readable logs" },
          ],
        }],
      },
      answerKeys: ["Should logs be JSON or plain text?"],
    });
  });

  it("keeps the original question text as the answer key while the card shows the bounded one", () => {
    // 도구는 **원문** 질문 텍스트로 답을 맞춘다. 표시용은 trim과 400자 상한을 지나므로,
    // 그 결과를 키로 쓰면 긴 질문에서 키가 어긋나 모델이 답을 받지 못한다(조용한 실패).
    const long = `${"왜 ".repeat(260)}이 방향으로 갈까요?`;
    const raw = `  ${long}  `;
    const parsed = agentChatAskFromToolInput("AskUserQuestion", "id-long", {
      questions: [{ question: raw, header: "Direction", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
    });
    expect(parsed?.answerKeys).toEqual([raw]);
    const shown = parsed?.event.questions?.[0]?.question ?? "";
    expect(shown.length).toBeLessThanOrEqual(400);
    expect(shown).not.toBe(raw);
  });

  it("never shortens an option label, because the label is what gets submitted", () => {
    // 라벨은 고르면 그대로 답이 되어 도구로 돌아간다 — 표시용으로 자르면 사용자가 고른 것과
    // 다른 값이 모델에게 간다. 길이는 카드가 접는다.
    const long = `${"아주 긴 선택지 라벨 ".repeat(20)}끝`;
    const parsed = agentChatAskFromToolInput("AskUserQuestion", "id-opt", {
      questions: [{ question: "어느 쪽?", header: "Pick", multiSelect: false, options: [{ label: long, description: "x" }, { label: "B", description: "" }] }],
    });
    expect(parsed?.event.questions?.[0]?.options[0]?.label).toBe(long);
  });

  it("reads a plan as its own form", () => {
    const parsed = agentChatAskFromToolInput("ExitPlanMode", "id-2", { plan: "1. do this\n2. then that", planFilePath: "/tmp/p.md" });
    expect(parsed).toEqual({
      event: { kind: "ask", id: "id-2", form: "plan", plan: "1. do this\n2. then that" },
      answerKeys: [],
    });
  });

  it("marks a plan the card could not show in full", () => {
    // 승인은 본 것에 동의한다는 뜻이다 — 잘린 계획은 그 사실을 이벤트가 말해야 카드가 승인을 닫는다.
    const short = agentChatAskFromToolInput("ExitPlanMode", "p1", { plan: "1. do this" });
    expect(short?.event.truncated).toBeUndefined();
    const huge = agentChatAskFromToolInput("ExitPlanMode", "p2", { plan: "가".repeat(60_001) });
    expect(huge?.event.truncated).toBe(true);
    expect((huge?.event.plan ?? "").length).toBeLessThanOrEqual(60_000);
  });

  it("returns null for a shape it cannot draw", () => {
    // 선택지 없는 질문, 빈 계획, 다른 도구 — 반쯤 읽은 카드를 세우느니 도구를 그냥 통과시킨다.
    expect(agentChatAskFromToolInput("AskUserQuestion", "x", { questions: [{ question: "q", header: "h", options: [] }] })).toBeNull();
    expect(agentChatAskFromToolInput("ExitPlanMode", "x", { plan: "   " })).toBeNull();
    expect(agentChatAskFromToolInput("Read", "x", { file_path: "/tmp/a" })).toBeNull();
  });
});

describe("AgentChatRegistry — interactive tools", () => {
  it("parks the question, reports awaiting, and hands the answer back as updatedInput", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const awaitingLog: boolean[] = [];
    const { session, events } = await startSession(registry, sdk, awaitingLog);

    const decision = sdk.ask("AskUserQuestion", QUESTION_INPUT);
    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event.kind === "ask")).toBe(true);
    });
    expect(awaitingLog).toEqual([true]);
    expect(session.awaiting).toBe(true);

    expect(session.answer("tool-1", { answers: ["JSON"] })).toEqual({ ok: true, outcome: "answered" });
    // 답은 권한 응답에 실려 돌아간다 — 질문 텍스트를 키로 하는 answers 하나가 통로다.
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...QUESTION_INPUT, answers: { "Should logs be JSON or plain text?": "JSON" } },
    });
    expect(awaitingLog).toEqual([true, false]);
    expect(session.awaiting).toBe(false);

    const settled = events.map((entry) => entry.event).find((event) => event.kind === "ask-settled");
    expect(settled).toEqual({
      kind: "ask-settled",
      id: "tool-1",
      outcome: "answered",
      answers: [{ header: "Log format", value: "JSON" }],
    });

    sdk.finish();
    await registry.disposeAll();
  });

  it("answers a bounded question under its original key so the resumed tool finds it", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const { session } = await startSession(registry, sdk, []);

    const raw = `  ${"왜 ".repeat(260)}이 방향으로 갈까요?  `;
    const input = {
      questions: [{ question: raw, header: "Direction", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
    };
    const decision = sdk.ask("AskUserQuestion", input);
    await vi.waitFor(() => { expect(session.awaiting).toBe(true); });
    expect(session.answer("tool-1", { answers: ["A"] })).toEqual({ ok: true, outcome: "answered" });
    // 키는 카드가 보여 준 축약본이 아니라 도구가 받은 원문이다.
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { [raw]: "A" } },
    });

    sdk.finish();
    await registry.disposeAll();
  });

  it("dismisses a question as a denial the model can read", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const awaitingLog: boolean[] = [];
    const { session, events } = await startSession(registry, sdk, awaitingLog);

    const decision = sdk.ask("AskUserQuestion", QUESTION_INPUT);
    await vi.waitFor(() => { expect(session.awaiting).toBe(true); });

    expect(session.answer("tool-1", {})).toEqual({ ok: true, outcome: "dismissed" });
    await expect(decision).resolves.toEqual({
      behavior: "deny",
      message: "The user dismissed the question without answering.",
    });
    expect(events.map((entry) => entry.event).find((event) => event.kind === "ask-settled")).toMatchObject({ outcome: "dismissed" });

    sdk.finish();
    await registry.disposeAll();
  });

  it("treats a plan approval as allow and a change request as a denial carrying the message", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const { session } = await startSession(registry, sdk, []);

    const approved = sdk.ask("ExitPlanMode", { plan: "1. rename\n2. verify", planFilePath: "/tmp/plan.md" }, "plan-1");
    await vi.waitFor(() => { expect(session.awaiting).toBe(true); });
    expect(session.answer("plan-1", { approve: true })).toEqual({ ok: true, outcome: "approved" });
    await expect(approved).resolves.toEqual({
      behavior: "allow",
      updatedInput: { plan: "1. rename\n2. verify", planFilePath: "/tmp/plan.md" },
    });

    const revised = sdk.ask("ExitPlanMode", { plan: "1. rename\n2. verify" }, "plan-2");
    await vi.waitFor(() => { expect(session.awaiting).toBe(true); });
    expect(session.answer("plan-2", { message: "narrow the scope to CSS only" })).toEqual({ ok: true, outcome: "revised" });
    // 거부는 되돌림이 아니라 되묻기다 — 이 문장이 그대로 모델에게 간다.
    await expect(revised).resolves.toEqual({ behavior: "deny", message: "narrow the scope to CSS only" });

    sdk.finish();
    await registry.disposeAll();
  });

  it("refuses to approve a plan it could not show, on the server rather than in the card", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const { session } = await startSession(registry, sdk, []);

    const plan = "가".repeat(60_050);
    const revised = sdk.ask("ExitPlanMode", { plan }, "plan-huge");
    await vi.waitFor(() => { expect(session.awaiting).toBe(true); });

    // 카드가 버튼을 감추는 것만으로는 규칙이 되지 않는다 — 리로드하지 않은 옛 번들은 그 플래그를
    // 모른 채 승인을 보낸다. 거절은 그 요청이 닿는 자리에 있어야 한다.
    expect(session.answer("plan-huge", { approve: true })).toEqual({ ok: false, error: "plan_truncated" });
    // 거절이 대기를 풀어 버리면 사용자는 답할 자리를 잃는다.
    expect(session.awaiting).toBe(true);

    // 수정 요청은 열려 있다 — 더 짧은 계획을 받아 오는 길이다.
    expect(session.answer("plan-huge", { message: "짧게 다시 주세요" })).toEqual({ ok: true, outcome: "revised" });
    await expect(revised).resolves.toEqual({ behavior: "deny", message: "짧게 다시 주세요" });

    sdk.finish();
    await registry.disposeAll();
  });

  it("keeps the question parked when the answer does not match the questions", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const { session } = await startSession(registry, sdk, []);

    sdk.ask("AskUserQuestion", QUESTION_INPUT);
    await vi.waitFor(() => { expect(session.awaiting).toBe(true); });

    expect(session.answer("tool-1", { answers: [] })).toEqual({ ok: false, error: "invalid_answer" });
    expect(session.answer("tool-1", { answers: ["  "] })).toEqual({ ok: false, error: "invalid_answer" });
    expect(session.answer("unknown-id", { answers: ["JSON"] })).toEqual({ ok: false, error: "ask_not_found" });
    // 거절된 답은 대기를 풀지 않는다 — 풀어 버리면 사용자는 답할 자리를 잃는다.
    expect(session.awaiting).toBe(true);

    sdk.finish();
    await registry.disposeAll();
  });

  it("lets every other tool through — the callback is not a permission gate", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const { session } = await startSession(registry, sdk, []);

    await expect(sdk.ask("Bash", { command: "rm -rf /tmp/nothing" })).resolves.toEqual({ behavior: "allow" });
    // 형태를 읽지 못한 대화형 도구도 막지 않는다.
    await expect(sdk.ask("AskUserQuestion", { questions: [] })).resolves.toEqual({ behavior: "allow" });
    expect(session.awaiting).toBe(false);

    sdk.finish();
    await registry.disposeAll();
  });

  it("denies immediately when the turn was already aborted before the card could be raised", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const awaitingLog: boolean[] = [];
    const { session } = await startSession(registry, sdk, awaitingLog);

    // AbortSignal은 지나간 abort를 재생하지 않는다 — 이미 끊긴 턴에 카드를 세우면 그 카드는
    // 리스너가 아니라 턴 종료 정리에 기대야 하고, 그 사이 화면은 끝난 턴을 대기로 보인다.
    const aborted = new AbortController();
    aborted.abort();
    await expect(sdk.askWith("AskUserQuestion", QUESTION_INPUT, "tool-dead", aborted.signal))
      .resolves.toEqual({ behavior: "deny", message: "The turn ended before the question was answered." });
    expect(session.awaiting).toBe(false);
    expect(awaitingLog).toEqual([]);

    sdk.finish();
    await registry.disposeAll();
  });

  it("releases a parked question when the session is disposed", async () => {
    const sdk = createPausedSdkFactory();
    const registry = new AgentChatRegistry(sdk.factory);
    const awaitingLog: boolean[] = [];
    const { session } = await startSession(registry, sdk, awaitingLog);

    const decision = sdk.ask("AskUserQuestion", QUESTION_INPUT);
    await vi.waitFor(() => { expect(session.awaiting).toBe(true); });

    // 만료가 없으므로 이 경로가 유일한 안전망이다 — 풀리지 않은 답 하나가 SDK 스트림을 영원히 붙든다.
    await registry.disposeAll();
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(awaitingLog.at(-1)).toBe(false);
  });
});
