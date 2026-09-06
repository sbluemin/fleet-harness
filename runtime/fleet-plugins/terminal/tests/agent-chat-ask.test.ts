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
  let settle: (() => void) | null = null;
  let closed = false;
  const openSession = vi.fn(async (request: Record<string, unknown>) => {
    canUseTool = request.canUseTool as CanUseTool;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    let delivered = false;
    return {
      send: vi.fn(),
      interrupt: vi.fn(async () => { settle?.(); }),
      stopTask: vi.fn(async () => {}),
      backgroundTasks: vi.fn(async () => true),
      getContextUsage: async () => null,
      close: vi.fn(() => { closed = true; settle?.(); }),
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // 문이 열리기 전에는 아무 말도 하지 않는다. 열리면 result 하나를 내고, 그 뒤로는
            // 세션이 접힐 때까지 다시 조용하다 — 실 세션의 수명 그대로다.
            await gate;
            if (delivered || closed) return { done: true as const, value: undefined };
            delivered = true;
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
      openSession,
      // 실제 SDK의 dispose는 활성 세션을 끊는다. 그것을 흉내 내지 않으면 스트림이 끝나지 않아
      // 테스트가 제품 코드 대신 픽스처에서 매달린다.
      dispose: vi.fn(async () => { closed = true; settle?.(); }),
    })) as never,
    openSession,
    ask: (name: string, input: Record<string, unknown>, toolUseId = "tool-1") => {
      if (!canUseTool) throw new Error("the turn has not started yet");
      return canUseTool(name, input, { toolUseId, signal: new AbortController().signal });
    },
    /** 신호를 직접 건네는 갈래 — 이미 끊긴 턴을 재현할 때 쓴다. */
    askWith: (name: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal) => {
      if (!canUseTool) throw new Error("the turn has not started yet");
      return canUseTool(name, input, { toolUseId, signal });
    },
    finish: () => { settle?.(); },
  };
}

function seedFor(awaitingLog: boolean[]): AgentChatSessionSeed {
  return {
    baseUrl: "http://127.0.0.1:9/gateway",
    model: "opus[1m]",
    cwd: "/tmp/workspace",
    claudeConfigDir: tempDir("chat-ask-home-"),
    origin: { kind: "fresh" },
    resolveClaudeSession: async () => {
      const sessionId = "11111111-2222-4333-8444-555555555555";
      const pluginRoot = `/fleet/workspaces/tmp-workspace/sessions/${sessionId}`;
      return {
        sessionId,
        coordinate: { kind: "new", sessionId },
        pluginRoot,
        pluginRoots: [pluginRoot],
        claudeCodeSystemPrompt: "off",
        sdk: {
          options: { plugins: [{ path: pluginRoot }], settingSources: ["user", "project", "local"], allowAmbientMcpServers: true },
          request: { sessionId, permissionMode: "bypassPermissions" },
        },
      };
    },
    onProviderSessionUpdate: () => {},
    reportActivity: () => true,
    canReportActivity: () => true,
    reportAwaiting: (awaiting) => { awaitingLog.push(awaiting); },
    reportBackgroundPending: () => {},
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
  await vi.waitFor(() => { expect(sdk.openSession).toHaveBeenCalled(); });
  return { session, events };
}

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
