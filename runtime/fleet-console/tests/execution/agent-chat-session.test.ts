import { appendFileSync, mkdirSync, mkdtempSync, promises as nodeFs, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeSessionHandle } from "@fleet-console/agent-runtime/fleet";

import { AgentChatRegistry, type AgentChatSessionSeed } from "../../features/execution/host/agent/chat-session.js";
import { createWorkspaceHookRegistry } from "../../features/execution/host/agent/workspace-hooks.js";
import { initialAgentChatLogState, reduceAgentChatLog } from "../../features/execution/client/agent/chat/chat-events.js";
import type { AgentChatJournalEvent, AgentChatStreamEvent } from "../../features/execution/host/agent/chat-events.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/** 원 세션 트랜스크립트 픽스처 — <홈>/projects/<인코딩 cwd>/<sid>.jsonl 모양 그대로. */
function writeTranscript(sessionId: string, lines: readonly unknown[]): string {
  const root = tempDir("chat-origin-");
  const projectDir = path.join(root, "projects", "-tmp-workspace");
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return transcriptPath;
}

/** 트랜스크립트가 앉은 Claude 홈. `<홈>/projects/<프로젝트>/<sid>.jsonl`을 세 번 되짚는다. */
function homeOf(transcriptPath: string): string {
  return path.dirname(path.dirname(path.dirname(transcriptPath)));
}

type FakeTurn = {
  readonly messages: readonly Record<string, unknown>[];
  readonly failAfter?: number;
  /** 이 턴이 시작할 때 자식이 돌려줄 문맥 내역. 없으면 답하지 않는 자식이다. */
  readonly context?: unknown;
  /**
   * 이 턴이 **닫힌 뒤** 자식이 돌려줄 문맥 내역. 부재는 시작 값 그대로다.
   *
   * 실물이 그렇게 답한다(실측 2026-08-17): 턴이 끝난 뒤의 요청도 거절되지 않고, 방금 끝난 턴을
   * 포함한 값이 온다. 그것을 재현하지 않으면 턴후 스냅숏 경로가 답 없는 자식 위에서 조용히
   * 초록으로 지나간다.
   */
  readonly contextAfter?: unknown;
};

/**
 * 실 세션처럼 **close 전까지 끝나지 않는** 스트림 하나를 흉내 낸다.
 *
 * 턴 스크립트는 그대로 유지하되 소비 시점이 바뀐다: 세션은 한 번 열리고, `send()`가 불릴 때마다
 * 다음 스크립트의 메시지가 그 스트림으로 흘러든다 — 자식 하나가 여러 턴을 사는 실제 모양이다.
 */
type FakeCatalog = {
  readonly commands: readonly { readonly name: string; readonly description: string; readonly argumentHint: string; readonly aliases: readonly string[] }[];
  readonly agents: readonly { readonly name: string; readonly description: string; readonly model: string | null }[];
  readonly skills?: readonly { readonly name: string; readonly description: string; readonly argumentHint: string; readonly aliases: readonly string[] }[];
  /** 이 축이 몇 번째 요청까지 "못 물었다"(`null`)로 답하는가. 일시적 실패를 재현한다. */
  readonly failCommandsFor?: number;
};

function fakeSession(turns: FakeTurn[], hooks: { readonly onSend?: (text: string, options?: { readonly messageId?: string }) => void; readonly onInterrupt?: () => void; readonly onStopTask?: (taskId: string) => void; readonly catalog?: FakeCatalog } = {}) {
  const queue: Record<string, unknown>[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;
  let failing = false;
  const wake = (): void => {
    const resume = waiting;
    waiting = null;
    resume?.();
  };
  let lastConsumed: FakeTurn | null = null;
  let commandAttempts = 0;
  return {
    send(text: string, options?: { readonly messageId?: string }): void {
      hooks.onSend?.(text, options);
      const script = turns.shift() ?? { messages: [] };
      lastConsumed = script;
      const upTo = script.failAfter ?? script.messages.length;
      queue.push(...script.messages.slice(0, upTo));
      if (script.failAfter !== undefined) failing = true;
      wake();
    },
    /** 자식이 스스로 내는 프레임 — 백그라운드 완료로 모델이 다시 깨어난 자리를 재현한다. */
    emit(...messages: Record<string, unknown>[]): void {
      queue.push(...messages);
      wake();
    },
    interrupt: async (): Promise<void> => { hooks.onInterrupt?.(); },
    stopTask: async (taskId: string): Promise<void> => { hooks.onStopTask?.(taskId); },
    backgroundTasks: async (): Promise<boolean> => true,
    /**
     * 카탈로그는 세션이 열린 직후 한 번 읽힌다. `null`은 "못 물었다"이고 빈 배열은 "물었는데
     * 없다"이므로, 답하지 않는 자식을 재현하려면 `hooks.catalog`를 주지 않으면 된다.
     */
    supportedCommands: async () => {
      // 계약상 `null`은 "못 물었다"다. 그 응답이 몇 번 이어지는지를 대본이 정한다.
      if (hooks.catalog?.failCommandsFor !== undefined && commandAttempts++ < hooks.catalog.failCommandsFor) return null;
      return hooks.catalog?.commands ?? null;
    },
    supportedAgents: async () => hooks.catalog?.agents ?? null,
    /** 스킬 이름의 주 출처. 실물은 첫 턴 전에도 답한다 — init을 기다리지 않는다. */
    supportedSkills: async () => hooks.catalog?.skills ?? null,
    reloadSkills: async () => hooks.catalog?.skills ?? null,
    /**
     * 실물은 턴 경계 **양쪽**에서 답한다(실측). 아직 아무것도 보내지 않았으면 다음 턴의 시작
     * 값이고, 한 번이라도 보낸 뒤에는 방금 소비한 턴의 종료 값이다 — 다음 턴의 시작 값 또한
     * 그것과 같은 순간이므로 같은 답이 옳다.
     */
    getContextUsage: async () => {
      if (lastConsumed === null) return turns[0]?.context ?? null;
      return lastConsumed.contextAfter ?? lastConsumed.context ?? null;
    },
    close(): void {
      closed = true;
      wake();
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Record<string, unknown>>> {
          for (;;) {
            const next = queue.shift();
            if (next !== undefined) return { done: false, value: next };
            if (failing) {
              failing = false;
              throw new Error("provider exploded");
            }
            if (closed) return { done: true, value: undefined };
            await new Promise<void>((resolve) => { waiting = resolve; });
          }
        },
      };
    },
  };
}

function createFakeSdkFactory(turns: FakeTurn[], catalog?: FakeCatalog) {
  const configDir = tempDir("chat-sdk-");
  const sends: string[] = [];
  // 실 SDK와 같이 슬롯은 하나다. `close()`가 불려야 자리가 돌아오며, 그전의 openSession은
  // 거절된다 — 스트림이 끝난 것과 슬롯이 반납된 것은 다른 사건이다.
  let occupied = false;
  let live: ReturnType<typeof fakeSession> | null = null;
  const openSession = vi.fn(async (_request: unknown) => {
    if (occupied) throw new Error("A turn or session is already running on this instance.");
    occupied = true;
    const session = fakeSession(turns, { onSend: (text) => sends.push(text), ...(catalog ? { catalog } : {}) });
    live = session;
    return {
      ...session,
      close: () => {
        occupied = false;
        session.close();
      },
    };
  });
  const dispose = vi.fn(async () => { occupied = false; });
  const factory = vi.fn(async (options: { readonly baseUrl: string; readonly models: readonly string[]; readonly ultracode?: true }) => ({
    configDir,
    models: options.models,
    startTurn: async () => { throw new Error("Chat Mode must run on a session, not a single turn."); },
    openSession,
    dispose,
  }));
  return { factory: factory as never, openSession, sends, dispose, configDir, liveSession: () => live };
}

function seedFor(transcriptPath: string, onProviderSessionUpdate: AgentChatSessionSeed["onProviderSessionUpdate"] = () => {}): AgentChatSessionSeed {
  return {
    baseUrl: "http://127.0.0.1:9/gateway",
    model: "opus[1m]",
    effort: "high",
    cwd: "/tmp/workspace",
    claudeConfigDir: homeOf(transcriptPath),
    origin: { kind: "resume", transcriptPath },
    // 이어 붙이는 세션은 id를 고를 수 없다 — 트랜스크립트가 말하는 id가 그대로 좌표다.
    resolveClaudeSession: async () => fakeClaudeSession({ resumeOf: path.basename(transcriptPath, ".jsonl") }),
    onProviderSessionUpdate,
    reportActivity: () => true,
    canReportActivity: () => true,
    reportAwaiting: () => {},
    reportBackgroundPending: () => {},
  };
}

/** 축이 지나간 상태들. 절대값은 같은 값으로도 다시 나가므로, 계약은 전이만 본다. */
function transitions(log: readonly boolean[]): boolean[] {
  return log.filter((value, index) => index === 0 || value !== log[index - 1]);
}

/** 백그라운드 대기 보고를 받아 적는 시드. 축에 실제로 실리는 값은 이 순서열이 전부다. */
function pendingSeedFor(transcriptPath: string, log: boolean[]): AgentChatSessionSeed {
  return { ...seedFor(transcriptPath), reportBackgroundPending: (pending) => { log.push(pending); } };
}

/** 채팅으로 태어난 세션의 시드 — 이어붙일 트랜스크립트가 없고 홈만 안다. */
function freshSeedFor(claudeConfigDir: string, onProviderSessionUpdate: AgentChatSessionSeed["onProviderSessionUpdate"] = () => {}): AgentChatSessionSeed {
  return {
    baseUrl: "http://127.0.0.1:9/gateway",
    model: "opus[1m]",
    effort: "high",
    cwd: "/tmp/workspace",
    claudeConfigDir,
    origin: { kind: "fresh" },
    resolveClaudeSession: async () => fakeClaudeSession(),
    onProviderSessionUpdate,
    reportActivity: () => true,
    canReportActivity: () => true,
    reportAwaiting: () => {},
    reportBackgroundPending: () => {},
  };
}

/**
 * admiral이 돌려주는 세션 핸들의 대역. 좌표와 능력 표면이 한 곳에서 나온다는 계약만 재현한다.
 */
function fakeClaudeSession(
  overrides: {
    readonly sessionId?: string;
    readonly resumeOf?: string;
    readonly claudeCodeSystemPrompt?: "on" | "off";
  } = {},
): ClaudeSessionHandle {
  const sessionId = overrides.resumeOf ?? overrides.sessionId ?? "11111111-2222-4333-8444-555555555555";
  const pluginUrl = "http://127.0.0.1:9/fleet-plugin-stub/fleet.zip";
  const claudeCodeSystemPrompt = overrides.claudeCodeSystemPrompt ?? "off";
  return {
    sessionId,
    coordinate: overrides.resumeOf ? { kind: "resume", sessionId } : { kind: "new", sessionId },
    pluginUrl,
    claudeCodeSystemPrompt,
    sdk: {
      options: {
        pluginUrl,
        settingSources: ["user", "project", "local"],
        allowAmbientMcpServers: true,
        skillOverrides: { "claude-api": "off" },
      },
      request: {
        ...(overrides.resumeOf ? { resume: sessionId } : { sessionId }),
        permissionMode: "bypassPermissions",
        ...(claudeCodeSystemPrompt === "on" ? { systemPrompt: { mode: "preset" } as const } : {}),
      },
    },
  };
}

async function drainTurn(registry: AgentChatRegistry, operationId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(registry.isBusy(operationId)).toBe(false);
  });
}

function kinds(events: readonly AgentChatJournalEvent[]): readonly string[] {
  return events.map((entry) => entry.event.kind);
}

function withoutSnapshotEnd(events: readonly AgentChatJournalEvent[]): readonly AgentChatJournalEvent[] {
  return events.filter((entry) => entry.event.kind !== "snapshot-end");
}

describe("AgentChatRegistry — chat-born sessions", () => {
  it("starts the first turn without a resume coordinate after an empty replay boundary", async () => {
    const home = tempDir("chat-home-");
    const { factory, openSession, sends, liveSession } = createFakeSdkFactory([
      { messages: [{ type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "source.ts" } }] } }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const cancelComputerUse = vi.fn();
    const session = await registry.ensure("op-1", () => ({ ...freshSeedFor(home), cancelComputerUse }));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    // 되돌릴 과거가 0턴이라는 사실도 명시적으로 닫힌 경계가 말한다.
    expect(kinds(events)).toEqual(["replay-start", "replay-end", "snapshot-end"]);

    session.send("let us talk about the render path");
    await vi.waitFor(() => expect(events.some(({ event }) => event.kind === "tool")).toBe(true));
    session.noteReceived({ id: "during", from: "commander", text: "While working." });
    liveSession()!.emit({ type: "result", subtype: "success", is_error: false, duration_ms: 10 });
    await drainTurn(registry, "op-1");
    session.noteReceived({ id: "after", from: "commander", text: "After completion." });
    expect(events.filter(({ event }) => event.kind === "received").map(({ event }) => event)).toMatchObject([
      { id: "during", inTurn: true }, { id: "after", inTurn: false },
    ]);
    const restored: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => restored.push(entry))();
    const fold = (entries: readonly AgentChatJournalEvent[]) => entries.reduce((log, entry) => reduceAgentChatLog(log, { ...entry.event, receivedAt: entry.at }), initialAgentChatLogState);
    expect(fold(restored).turns).toEqual(fold(events).turns);

    expect(cancelComputerUse).toHaveBeenCalledTimes(1);
    expect(sends).toEqual(["let us talk about the render path"]);
    const request = openSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("resume" in request).toBe(false);
    await registry.disposeAll();
  });

  // Console 자신이 Fleet 터미널에서 떴다면 그 세션 id를 상속하고 있다. 자식에게 따라가면
  // 자식의 훅이 남의 세션 축에 턴을 보고한다.
  it("keeps the inherited terminal session id out of the sdk child", async () => {
    const home = tempDir("chat-home-");
    const previous = process.env.FLEET_CONSOLE_SESSION_ID;
    process.env.FLEET_CONSOLE_SESSION_ID = "someone-elses-session";
    try {
      const { factory } = createFakeSdkFactory([
        { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
      ]);
      const locations: string[] = [];
      const workspaceHooks = createWorkspaceHookRegistry((_id, cwd) => locations.push(cwd));
      const registry = new AgentChatRegistry(factory);
      const session = await registry.ensure("op-env", () => ({
        ...freshSeedFor(home),
        bindWorkspaceHook: (id) => workspaceHooks.bind("op-env", id, () => true),
      }));
      session.send("go");
      await drainTurn(registry, "op-env");

      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.not.objectContaining({ FLEET_CONSOLE_SESSION_ID: expect.anything() }),
      }));
      const env = (vi.mocked(factory as (options: { env: NodeJS.ProcessEnv }) => unknown).mock.calls[0]![0]).env;
      expect(env.FLEET_CONSOLE_WORKSPACE_SESSION_ID).toBe("op-env");
      const cwd = path.resolve("chat-moved");
      const input = JSON.stringify({ hook_event_name: "CwdChanged", session_id: fakeClaudeSession().sessionId, new_cwd: cwd });
      expect(workspaceHooks.report("op-env", env.FLEET_CONSOLE_WORKSPACE_RUN_ID, input, 1)).toBe(true);
      expect(locations).toEqual([cwd]);
      await registry.disposeAll();
      expect(workspaceHooks.report("op-env", env.FLEET_CONSOLE_WORKSPACE_RUN_ID, input, 2)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.FLEET_CONSOLE_SESSION_ID;
      else process.env.FLEET_CONSOLE_SESSION_ID = previous;
    }
  });
});

describe("AgentChatRegistry", () => {

  // 자식이 죽으면 그 세션도 죽는다. 다음 메시지는 새 자식을 세우고 마지막 좌표로 이어붙인다 —
  // 죽은 세션을 붙들고 있으면 사용자는 다시 말할 수 없다.
  it("opens a fresh session after the child dies and keeps accepting sends", async () => {
    const transcriptPath = writeTranscript("sid-4", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, openSession } = createFakeSdkFactory([
      { messages: [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }], failAfter: 1 },
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("first");
    await drainTurn(registry, "op-1");
    expect(kinds(events)).toContain("error");
    expect(events.some((entry) => entry.event.kind === "turn-end" && entry.event.ok === false)).toBe(true);

    session.send("second");
    await drainTurn(registry, "op-1");
    expect(openSession).toHaveBeenCalledTimes(2);
    await registry.disposeAll();
  });

  it("dispose waits for an in-flight ensure so no chat session survives it", async () => {
    const transcriptPath = writeTranscript("sid-7", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const sdkDispose = vi.fn(async () => {});
    const factory = (async () => ({
      configDir: tempDir("chat-sdk-"),
      models: ["opus[1m]"],
      openSession: async () => { throw new Error("unused"); },
      dispose: sdkDispose,
    })) as never;
    const registry = new AgentChatRegistry(factory);

    const ensureFlight = registry.ensure("op-1", () => seedFor(transcriptPath));
    await registry.dispose("op-1");

    await ensureFlight.catch(() => undefined);
    expect(registry.has("op-1")).toBe(false);
    await registry.disposeAll();
  });
});

/**
 * 백그라운드 작업이 세션의 것이 되면서 생긴 계약들.
 *
 * 요점은 수명이다 — 자식이 사는 동안 잡도 살고, 자식이 사라지면 잡도 사라진다. 원장은 그
 * 두 사실을 모두 말해야 하며, 어느 쪽도 지어내지 않아야 한다.
 */
describe("AgentChatRegistry — background jobs", () => {
  it("shows a workflow agent's actual response model, not the requested pin", async () => {
    const sessionId = "sess-wf-model";
    const transcriptPath = writeTranscript(sessionId, []);
    const agentId = "a1b2c3d4e5f6a7b8";
    const childDir = path.join(path.dirname(transcriptPath), sessionId, "subagents", "workflows", "run1");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(path.join(childDir, `agent-${agentId}.jsonl`), [
      JSON.stringify({ type: "user", message: { role: "user", content: "probe" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-gateway--cursor--composer-1.5",
          content: [{ type: "text", text: "done" }],
        },
      }),
    ].join("\n"));
    const requested = "claude-gateway--xai--grok-4";
    const { factory } = createFakeSdkFactory([{
      messages: [
        {
          type: "system",
          subtype: "task_started",
          task_id: "wf-1",
          task_type: "local_workflow",
          description: "native-browser-feasibility",
          workflow_name: "probe",
        },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-1",
          description: "running",
          usage: { total_tokens: 12, tool_uses: 1, duration_ms: 40 },
          workflow_progress: [
            { type: "workflow_phase", title: "Measure" },
            {
              type: "workflow_agent",
              index: 1,
              label: "composer-run",
              phaseTitle: "Measure",
              agentId,
              model: requested,
              state: "done",
              tokens: 12,
              toolCalls: 1,
              durationMs: 40,
            },
            {
              type: "workflow_agent",
              index: 2,
              label: "pending-run",
              phaseTitle: "Measure",
              model: requested,
              state: "start",
            },
          ],
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "wf-1",
          status: "completed",
          summary: "measured",
        },
        { type: "result", subtype: "success", is_error: false, duration_ms: 50 },
      ],
    }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-wf-1", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));
    session.send("run the workflow");
    await drainTurn(registry, "op-wf-1");

    await vi.waitFor(() => {
      const progress = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progress?.event).toMatchObject({
        kind: "job-progress",
        id: "wf-1",
        stages: [{
          title: "Measure",
          agents: [
            { label: "composer-run", model: "claude-gateway--cursor--composer-1.5", state: "done" },
            { label: "pending-run", state: "start" },
          ],
        }],
      });
    });
    for (const entry of seen) {
      if (entry.event.kind !== "job-progress" || entry.event.stages === undefined) continue;
      for (const stage of entry.event.stages) {
        for (const agent of stage.agents) {
          expect(agent.model).not.toBe(requested);
        }
      }
    }

    const restored: AgentChatJournalEvent[] = [];
    const unsubscribe = session.subscribe((entry) => restored.push(entry));
    unsubscribe();
    const replayed = restored.find((entry) => entry.event.kind === "job-progress");
    expect(replayed?.event).toMatchObject({
      kind: "job-progress",
      stages: [{
        agents: [
          { label: "composer-run", model: "claude-gateway--cursor--composer-1.5" },
          { label: "pending-run", state: "start" },
        ],
      }],
    });
    expect(replayed?.event.kind === "job-progress" ? replayed.event.stages?.[0]?.agents[1]?.model : "missing").toBeUndefined();

    let log = initialAgentChatLogState;
    for (const entry of seen) {
      log = reduceAgentChatLog(log, { ...entry.event, receivedAt: entry.at });
    }
    expect(log.jobs).toHaveLength(1);
    expect(log.jobs[0]).toMatchObject({
      id: "wf-1",
      kind: "workflow",
      open: false,
      status: "completed",
      stages: [{
        agents: [
          { label: "composer-run", model: "claude-gateway--cursor--composer-1.5" },
          { label: "pending-run", state: "start" },
        ],
      }],
    });
    await registry.disposeAll();
  });

  it("replaces a workflow model when the child transcript later names a different one", async () => {
    const sessionId = "sess-wf-fallback";
    const transcriptPath = writeTranscript(sessionId, []);
    const agentId = "b1c2d3e4f5a6b7c8";
    const childFile = path.join(path.dirname(transcriptPath), sessionId, "subagents", "workflows", "run1", `agent-${agentId}.jsonl`);
    mkdirSync(path.dirname(childFile), { recursive: true });
    writeFileSync(childFile, `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-gateway--cursor--composer-1.5", content: [{ type: "text", text: "first" }] },
    })}\n`);
    const progress = {
      type: "system",
      subtype: "task_progress",
      task_id: "wf-2",
      description: "running",
      usage: { total_tokens: 3, tool_uses: 0, duration_ms: 10 },
      workflow_progress: [{
        type: "workflow_agent",
        index: 1,
        label: "fallback-run",
        phaseTitle: "Measure",
        agentId,
        model: "claude-gateway--xai--grok-4",
        state: "running",
      }],
    };
    const { factory, liveSession } = createFakeSdkFactory([{
      messages: [
        { type: "system", subtype: "task_started", task_id: "wf-2", task_type: "local_workflow", description: "fallback" },
        progress,
        { type: "result", subtype: "success", is_error: false, duration_ms: 20 },
      ],
    }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-wf-2", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));
    session.send("run");
    await drainTurn(registry, "op-wf-2");
    await vi.waitFor(() => {
      const progressEvent = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progressEvent?.event).toMatchObject({
        kind: "job-progress",
        stages: [{ agents: [{ model: "claude-gateway--cursor--composer-1.5" }] }],
      });
    });

    // CLI 2.1.278: 한도 대기 overlay는 같은 type:index 행을 agentId 없이 통째로 갈아 끼운다.
    liveSession()!.emit({
      ...progress,
      workflow_progress: [{
        type: "workflow_agent",
        index: 1,
        label: "fallback-run",
        phaseTitle: "Measure",
        model: "claude-gateway--xai--grok-4",
        state: "start",
        tokens: 3,
        toolCalls: 0,
      }],
    });
    await vi.waitFor(() => {
      const progressEvent = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progressEvent?.event).toMatchObject({
        kind: "job-progress",
        stages: [{ agents: [{ label: "fallback-run", model: "claude-gateway--cursor--composer-1.5" }] }],
      });
    });

    appendFileSync(childFile, `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-gateway--deepseek--v3.1", content: [{ type: "text", text: "retried" }] },
    })}\n`);
    liveSession()!.emit(progress);
    await vi.waitFor(() => {
      const progressEvent = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progressEvent?.event).toMatchObject({
        kind: "job-progress",
        stages: [{ agents: [{ model: "claude-gateway--deepseek--v3.1" }] }],
      });
    });
    await registry.disposeAll();
  });

  it("keeps workflow models by CLI agent index when a later stage inserts a row", async () => {
    const sessionId = "sess-wf-interleave";
    const transcriptPath = writeTranscript(sessionId, []);
    const childDir = path.join(path.dirname(transcriptPath), sessionId, "subagents", "workflows", "run1");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(path.join(childDir, "agent-a1b2c3d4e5f6a7b1.jsonl"), `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-gateway--cursor--composer-1.5", content: [{ type: "text", text: "a1" }] },
    })}\n`);
    writeFileSync(path.join(childDir, "agent-a1b2c3d4e5f6b7c1.jsonl"), `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-gateway--deepseek--v3.1", content: [{ type: "text", text: "b1" }] },
    })}\n`);
    const first = [
      { type: "workflow_agent", index: 1, label: "A1", phaseTitle: "Alpha", agentId: "a1b2c3d4e5f6a7b1", model: "claude-gateway--xai--grok-4", state: "done" },
      { type: "workflow_agent", index: 2, label: "B1", phaseTitle: "Bravo", agentId: "a1b2c3d4e5f6b7c1", model: "claude-gateway--xai--grok-4", state: "done" },
    ];
    const inserted = [
      { type: "workflow_agent", index: 1, label: "A1", phaseTitle: "Alpha", agentId: "a1b2c3d4e5f6a7b1", model: "claude-gateway--xai--grok-4", state: "done" },
      { type: "workflow_agent", index: 3, label: "A2", phaseTitle: "Alpha", model: "claude-gateway--xai--grok-4", state: "start" },
      { type: "workflow_agent", index: 2, label: "B1", phaseTitle: "Bravo", model: "claude-gateway--xai--grok-4", state: "done" },
    ];
    const { factory, liveSession } = createFakeSdkFactory([{
      messages: [
        { type: "system", subtype: "task_started", task_id: "wf-int", task_type: "local_workflow", description: "interleave" },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-int",
          description: "running",
          usage: { total_tokens: 2, tool_uses: 0, duration_ms: 10 },
          workflow_progress: first,
        },
        { type: "result", subtype: "success", is_error: false, duration_ms: 20 },
      ],
    }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-wf-int", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));
    session.send("run");
    await drainTurn(registry, "op-wf-int");
    await vi.waitFor(() => {
      const progress = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progress?.event).toMatchObject({
        kind: "job-progress",
        stages: [
          { title: "Alpha", agents: [{ label: "A1", model: "claude-gateway--cursor--composer-1.5" }] },
          { title: "Bravo", agents: [{ label: "B1", model: "claude-gateway--deepseek--v3.1" }] },
        ],
      });
    });
    liveSession()!.emit({
      type: "system",
      subtype: "task_progress",
      task_id: "wf-int",
      description: "running",
      usage: { total_tokens: 3, tool_uses: 0, duration_ms: 20 },
      workflow_progress: inserted,
    });
    await vi.waitFor(() => {
      const progress = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progress?.event).toMatchObject({
        kind: "job-progress",
        stages: [
          {
            title: "Alpha",
            agents: [
              { label: "A1", model: "claude-gateway--cursor--composer-1.5" },
              { label: "A2", state: "start" },
            ],
          },
          { title: "Bravo", agents: [{ label: "B1", model: "claude-gateway--deepseek--v3.1" }] },
        ],
      });
      if (progress?.event.kind !== "job-progress") return;
      expect(progress.event.stages?.[0]?.agents[1]?.model).toBeUndefined();
    });
    await registry.disposeAll();
  });

  it("reads the actual model when the last assistant record is larger than the first tail window", async () => {
    const sessionId = "sess-wf-huge";
    const transcriptPath = writeTranscript(sessionId, []);
    const agentId = "c1d2e3f4a5b6c7d8";
    const childFile = path.join(path.dirname(transcriptPath), sessionId, "subagents", "workflows", "run1", `agent-${agentId}.jsonl`);
    mkdirSync(path.dirname(childFile), { recursive: true });
    writeFileSync(childFile, `${JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-gateway--cursor--composer-1.5",
        content: [{ type: "text", text: "x".repeat(300_000) }],
      },
    })}\n`);
    const { factory } = createFakeSdkFactory([{
      messages: [
        { type: "system", subtype: "task_started", task_id: "wf-huge", task_type: "local_workflow", description: "huge" },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-huge",
          description: "running",
          usage: { total_tokens: 1, tool_uses: 1, duration_ms: 10 },
          workflow_progress: [{
            type: "workflow_agent",
            index: 1,
            label: "huge-run",
            phaseTitle: "Measure",
            agentId,
            model: "claude-gateway--xai--grok-4",
            state: "done",
          }],
        },
        { type: "system", subtype: "task_notification", task_id: "wf-huge", status: "completed", summary: "huge" },
        { type: "result", subtype: "success", is_error: false, duration_ms: 20 },
      ],
    }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-wf-huge", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));
    session.send("run");
    await drainTurn(registry, "op-wf-huge");
    await vi.waitFor(() => {
      const progress = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progress?.event).toMatchObject({
        kind: "job-progress",
        stages: [{ agents: [{ model: "claude-gateway--cursor--composer-1.5" }] }],
      });
    });
    let log = initialAgentChatLogState;
    for (const entry of seen) log = reduceAgentChatLog(log, { ...entry.event, receivedAt: entry.at });
    expect(log.jobs[0]).toMatchObject({ id: "wf-huge", open: false, status: "completed" });
    await registry.disposeAll();
  });

  it("keeps every agent model in a workflow larger than the job-kind cap", async () => {
    const sessionId = "sess-wf-wide";
    const transcriptPath = writeTranscript(sessionId, []);
    const childDir = path.join(path.dirname(transcriptPath), sessionId, "subagents", "workflows", "run1");
    mkdirSync(childDir, { recursive: true });
    const agentCount = 201;
    const requested = "claude-gateway--xai--grok-4";
    const agents = Array.from({ length: agentCount }, (_, index) => {
      const agentId = `ag${String(index).padStart(3, "0")}`;
      const model = `claude-gateway--cursor--composer-${index}`;
      writeFileSync(path.join(childDir, `agent-${agentId}.jsonl`), `${JSON.stringify({
        type: "assistant",
        message: { model, content: [{ type: "text", text: "ok" }] },
      })}\n`);
      return {
        type: "workflow_agent",
        index: index + 1,
        label: `run-${index}`,
        phaseTitle: `Stage-${Math.floor(index / 64)}`,
        agentId,
        model: requested,
        state: "done",
      };
    });
    const { factory } = createFakeSdkFactory([{
      messages: [
        { type: "system", subtype: "task_started", task_id: "wf-wide", task_type: "local_workflow", description: "wide" },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-wide",
          description: "running",
          usage: { total_tokens: agentCount, tool_uses: 0, duration_ms: 10 },
          workflow_progress: agents,
        },
        { type: "system", subtype: "task_notification", task_id: "wf-wide", status: "completed", summary: "wide" },
        { type: "result", subtype: "success", is_error: false, duration_ms: 20 },
      ],
    }]);
    const open = nodeFs.open.bind(nodeFs);
    const stat = nodeFs.stat.bind(nodeFs);
    let inflight = 0;
    let maxInflight = 0;
    const track = async <T,>(work: () => Promise<T>): Promise<T> => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        return await work();
      } finally {
        inflight -= 1;
      }
    };
    const openSpy = vi.spyOn(nodeFs, "open").mockImplementation((...args) => track(() => open(...args)));
    const statSpy = vi.spyOn(nodeFs, "stat").mockImplementation((...args) => track(() => stat(...args)));
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-wf-wide", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));
    session.send("run");
    await drainTurn(registry, "op-wf-wide");
    await vi.waitFor(() => {
      const progress = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progress?.event.kind).toBe("job-progress");
      if (progress?.event.kind !== "job-progress") return;
      const painted = progress.event.stages?.flatMap((stage) => stage.agents) ?? [];
      expect(painted).toHaveLength(agentCount);
      expect(painted[0]?.model).toBe("claude-gateway--cursor--composer-0");
      expect(painted[200]?.model).toBe("claude-gateway--cursor--composer-200");
      expect(painted.some((agent) => agent.model === undefined || agent.model === requested)).toBe(false);
    });
    expect(maxInflight).toBeLessThanOrEqual(4);
    let log = initialAgentChatLogState;
    for (const entry of seen) log = reduceAgentChatLog(log, { ...entry.event, receivedAt: entry.at });
    expect(log.jobs[0]).toMatchObject({ id: "wf-wide", open: false, status: "completed" });
    expect(log.jobs[0]?.stages.flatMap((stage) => stage.agents)).toHaveLength(agentCount);
    openSpy.mockRestore();
    statSpy.mockRestore();
    await registry.disposeAll();
  });

  it("keeps models when stage titles are absolute paths the abbreviator would collapse", async () => {
    const sessionId = "sess-wf-paths";
    const transcriptPath = writeTranscript(sessionId, []);
    const childDir = path.join(path.dirname(transcriptPath), sessionId, "subagents", "workflows", "run1");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(path.join(childDir, "agent-a1b2c3d4e5f6a7b1.jsonl"), `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-gateway--cursor--composer-1.5", content: [{ type: "text", text: "a1" }] },
    })}\n`);
    writeFileSync(path.join(childDir, "agent-a1b2c3d4e5f6b7c1.jsonl"), `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-gateway--deepseek--v3.1", content: [{ type: "text", text: "b1" }] },
    })}\n`);
    const { factory } = createFakeSdkFactory([{
      messages: [
        { type: "system", subtype: "task_started", task_id: "wf-paths", task_type: "local_workflow", description: "paths" },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-paths",
          description: "running",
          usage: { total_tokens: 3, tool_uses: 0, duration_ms: 10 },
          workflow_progress: [
            { type: "workflow_agent", index: 1, label: "A1", phaseTitle: "/one/common/stage", agentId: "a1b2c3d4e5f6a7b1", model: "claude-gateway--xai--grok-4", state: "done" },
            { type: "workflow_agent", index: 2, label: "B1", phaseTitle: "/two/common/stage", agentId: "a1b2c3d4e5f6b7c1", model: "claude-gateway--xai--grok-4", state: "done" },
            { type: "workflow_agent", index: 3, label: "A2", phaseTitle: "/one/common/stage", model: "claude-gateway--xai--grok-4", state: "start" },
          ],
        },
        { type: "system", subtype: "task_notification", task_id: "wf-paths", status: "completed", summary: "paths" },
        { type: "result", subtype: "success", is_error: false, duration_ms: 20 },
      ],
    }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-wf-paths", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));
    session.send("run");
    await drainTurn(registry, "op-wf-paths");
    await vi.waitFor(() => {
      const progress = [...seen].reverse().find((entry) => entry.event.kind === "job-progress");
      expect(progress?.event).toMatchObject({
        kind: "job-progress",
        stages: [
          {
            title: "/one/common/stage",
            agents: [
              { label: "A1", model: "claude-gateway--cursor--composer-1.5" },
              { label: "A2", state: "start" },
            ],
          },
          { title: "/two/common/stage", agents: [{ label: "B1", model: "claude-gateway--deepseek--v3.1" }] },
        ],
      });
      if (progress?.event.kind !== "job-progress") return;
      expect(progress.event.stages?.[0]?.agents[1]?.model).toBeUndefined();
    });
    await registry.disposeAll();
  });
});

/**
 * 사용자가 도는 턴을 끊는 자리.
 *
 * 이 축의 요점은 결말의 이름이다 — 중지는 실패가 아니다. 원장이 둘을 같은 자리에 두면 사용자가
 * 자기가 누른 버튼의 결과를 고장으로 읽는다.
 */
describe("AgentChatRegistry — stopping a turn", () => {
  /** 스스로 아무 말도 하지 않는 자식. 중지가 유일한 탈출구인 상태를 그대로 만든다. */
  function createHangingSdkFactory() {
    const configDir = tempDir("chat-stop-");
    const interrupts: string[] = [];
    const sends: string[] = [];
    const openSession = vi.fn(async () => fakeSession([], {
      onSend: (text) => sends.push(text),
      onInterrupt: () => interrupts.push("interrupt"),
    }));
    const factory = vi.fn(async ({ models }: { readonly baseUrl: string; readonly models: readonly string[] }) => ({
      configDir,
      models,
      openSession,
      dispose: vi.fn(async () => {}),
    }));
    return { factory: factory as never, openSession, interrupts, sends };
  }

  it("interrupts the child and closes the turn as stopped, not failed", async () => {
    const transcriptPath = writeTranscript("sess-stop", []);
    const { factory, interrupts } = createHangingSdkFactory();
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-1", () => seedFor(transcriptPath));

    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("go");
    await vi.waitFor(() => { expect(kinds(seen)).toContain("turn-start"); });

    expect(session.stopTurn()).toBe(true);
    await drainTurn(registry, "op-stop-1");

    // 중지는 턴만 끊는다 — 자식은 살아 있고, 그래서 이미 태어난 백그라운드 작업도 산다.
    await vi.waitFor(() => { expect(interrupts).toHaveLength(1); });
    const end = seen.map((entry) => entry.event).find((event) => event.kind === "turn-end");
    expect(end).toEqual({ kind: "turn-end", ok: false, stopped: true });
    // 중지는 오류 줄을 세우지 않는다 — 사용자가 스스로 한 일에 고장 표식을 붙이지 않는다.
    expect(kinds(seen)).not.toContain("error");
    await registry.disposeAll();
  });

  /** 마지막으로 실린 예약 전량. REPLACE 시맨틱이라 최신 하나가 곧 지금의 사정이다. */
  function latestQueue(events: readonly AgentChatJournalEvent[]): readonly { readonly id: string; readonly text: string }[] {
    const queue = events.map((entry) => entry.event).filter((event) => event.kind === "queue");
    return queue.at(-1)?.entries ?? [];
  }

  it("refuses when there is no turn to stop", async () => {
    // 끊을 것이 없는데 성공을 돌려주면 화면이 멈춤을 그리고 아무 일도 일어나지 않는다.
    const transcriptPath = writeTranscript("sess-stop-idle", []);
    const { factory } = createHangingSdkFactory();
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-3", () => seedFor(transcriptPath));
    expect(session.stopTurn()).toBe(false);
    await registry.disposeAll();
  });

  /**
   * 턴이 도는 동안 보낸 말은 그 턴이 집어간다 — Claude Code CLI와 같은 자리다.
   *
   * 이 셋이 한 계약이다: 말은 **기다리지 않고** 자식에게 건너가고, 자식이 집어갔다고 말하기
   * 전까지는 **원장에 서지 않으며**, 건넨 뒤에는 **거둘 수 없다**. 마지막 하나가 특히 중요하다 —
   * 칩만 지우고 성공을 돌려주면 화면은 거뒀다고 말하고 모델은 그 말을 읽는다.
   */
  it("hands a mid-turn message to the child at once and seats it inside the running turn", async () => {
    const transcriptPath = writeTranscript("sess-inject", []);
    const configDir = tempDir("chat-inject-");
    const sends: { readonly text: string; readonly messageId?: string }[] = [];
    let child: ReturnType<typeof fakeSession> | null = null;
    const openSession = vi.fn(async () => {
      child = fakeSession([], { onSend: (text, options) => sends.push({ text, ...(options?.messageId ? { messageId: options.messageId } : {}) }) });
      return child;
    });
    const factory = vi.fn(async ({ models }: { readonly baseUrl: string; readonly models: readonly string[] }) => ({
      configDir,
      models,
      openSession,
      dispose: vi.fn(async () => {}),
    }));
    const registry = new AgentChatRegistry(factory as never);
    const session = await registry.ensure("op-inject-1", () => seedFor(transcriptPath));

    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("첫 지시");
    // 자식에게 닿은 뒤라야 "도는 턴"이다 — 닿기 전의 턴은 아직 건넬 자리가 없다.
    await vi.waitFor(() => {
      expect(kinds(seen)).toContain("turn-start");
      expect(sends).toHaveLength(1);
    });

    session.send("방향을 바꿔줘");
    // 앞 턴이 닫히기를 기다리지 않는다. 기다리면 사용자가 고쳐 준 말이 이미 끝난 일에 도착한다.
    await vi.waitFor(() => { expect(sends).toHaveLength(2); });
    expect(sends[1]?.text).toBe("방향을 바꿔줘");
    // 좌표 없이 건네면 자식이 그 말의 행방을 말해 줄 길이 없다.
    const messageId = sends[1]?.messageId;
    expect(typeof messageId).toBe("string");
    // 아직 원장에는 서지 않는다 — 도는 턴이 집어갈지 제 턴으로 설지는 자식만 안다.
    expect(kinds(seen)).not.toContain("turn-inject");
    // 건넨 말은 거둘 수 없다. 칩 좌표가 있어도 취소는 거절이어야 한다 — 칩만 지우고 성공을
    // 돌려주면 화면은 거뒀다고 말하고 모델은 그 말을 읽는다.
    const queued = latestQueue(seen);
    expect(queued).toHaveLength(1);
    expect(session.cancelQueued(queued[0]!.id)).toBe(false);

    // 자식이 집어갔다고 말한다. 이제서야 원장에 서고, 새 턴은 열리지 않는다.
    child!.emit({ type: "command_lifecycle", state: "started", command_uuid: messageId });
    await vi.waitFor(() => { expect(kinds(seen)).toContain("turn-inject"); });
    expect(kinds(seen).filter((kind) => kind === "turn-start")).toHaveLength(1);
    expect(latestQueue(seen)).toHaveLength(0);

    await registry.disposeAll();
  });
});

/**
 * 잡 상세를 읽는 자리.
 *
 * 셸 출력의 좌표는 우리가 재구성할 수 없다 — 실측에서 그 파일은 격리 config dir이 아니라 CLI가
 * 고른 **별개의 임시 뿌리** 아래 앉았다. `task_notification.output_file`이 알려 주는 경로가
 * 유일한 권위이고, 그 경로는 호스트 절대 경로라 브라우저로 나가서는 안 된다.
 */

/**
 * 큰 출력 파일.
 *
 * 돌려주는 값이 작아도 파일 전체를 문자열로 올리면 그 순간의 메모리와 이벤트 루프는 파일
 * 크기만큼을 진다 — 실측에서 백그라운드 셸 출력은 이미 438KB까지 자랐고, 빌드를 백그라운드로
 * 돌리면 수십 MB가 정상 범위다.
 */

/**
 * 창보다 큰 줄 하나.
 *
 * 앞선 경계-읽기 수정이 만든 결함이다: 줄 경계에 맞추려고 첫 개행까지를 버리는데, 마지막 한
 * 줄이 창보다 크면 개행이 창의 맨 끝에만 있거나 아예 없어서 버퍼 전체가 사라진다. 화면은 그때
 * 빈 꼬리를 보인다 — 잘린 줄 하나가 빈 화면보다 정직하다.
 */
