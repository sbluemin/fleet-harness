import { mkdirSync, mkdtempSync, promises as nodeFs, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeSessionHandle } from "@dotobokuri/fleet-admiral";

import { AgentChatRegistry, type AgentChatSessionSeed } from "../server/agent-api/chat-session.js";
import { initialAgentChatLogState, reduceAgentChatLog } from "../client/agent/chat/chat-events.js";
import type { AgentChatJournalEvent } from "../server/agent-api/chat-events.js";

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
};

function fakeSession(turns: FakeTurn[], hooks: { readonly onSend?: (text: string) => void; readonly onInterrupt?: () => void; readonly onStopTask?: (taskId: string) => void; readonly catalog?: FakeCatalog } = {}) {
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
  return {
    send(text: string): void {
      hooks.onSend?.(text);
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
    supportedCommands: async () => hooks.catalog?.commands ?? null,
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
    readonly pluginRoot?: string;
    readonly claudeCodeSystemPrompt?: "on" | "off";
  } = {},
): ClaudeSessionHandle {
  const sessionId = overrides.resumeOf ?? overrides.sessionId ?? "11111111-2222-4333-8444-555555555555";
  const pluginRoot = overrides.pluginRoot ?? `/fleet/workspaces/tmp-workspace/sessions/${sessionId}`;
  const claudeCodeSystemPrompt = overrides.claudeCodeSystemPrompt ?? "off";
  return {
    sessionId,
    coordinate: overrides.resumeOf ? { kind: "resume", sessionId } : { kind: "new", sessionId },
    pluginRoot,
    pluginRoots: [pluginRoot],
    claudeCodeSystemPrompt,
    sdk: {
      options: {
        plugins: [{ path: pluginRoot }],
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

describe("AgentChatRegistry — composer capability catalog", () => {
  const CATALOG = {
    commands: [
      { name: "clear", description: "Clear the conversation", argumentHint: "", aliases: [] },
      { name: "compact", description: "Summarize to reclaim context", argumentHint: "[instructions]", aliases: [] },
      { name: "console-e2e", description: "Drive a headless browser test", argumentHint: "", aliases: [] },
    ],
    agents: [
      { name: "Explore", description: "Read-only search agent", model: null },
    ],
  } as const;

  /**
   * 덱의 두 카테고리를 가르는 유일한 근거는 init이 실어 온 스킬 이름 집합이다 —
   * `supportedCommands()`는 내장 명령과 스킬을 한 타입으로 주고 카테고리를 말하지 않는다.
   */
  it("splits commands from skills using the init skill names", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5 }] },
    ], CATALOG);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-cat", () => freshSeedFor(home));
    const catalog = await session.readCatalog();
    expect(catalog).not.toBeNull();
    expect(catalog!.agents.map((entry) => entry.name)).toEqual(["Explore"]);
    // init이 없어도 정책표가 부정 증거로 답한다: 표는 실재하는 내장 명령의 전량이므로 "표에
    // 없다"가 곧 "내장 명령이 아니다"다. 스킬 이름의 세 긍정 출처가 전부 침묵해도 카테고리가 선다.
    expect(catalog!.commands.map((entry) => entry.name)).toEqual(["clear", "compact"]);
    expect(catalog!.skills.map((entry) => entry.name)).toEqual(["console-e2e"]);
    // 추정으로 스킬 칸에 세운 이름은 함께 실어 보낸다 — 표를 갱신할 사람이 그것을 봐야 한다.
    expect(catalog!.unclassified).toEqual(["console-e2e"]);
    expect(catalog!.commands.find((entry) => entry.name === "compact")!.argumentHint).toBe("[instructions]");
    await registry.disposeAll();
  });

  /**
   * 실측에서 잡힌 결함: `/`만 눌러 연 세션은 아직 턴을 돌지 않았고, init 메시지는 **첫 턴과
   * 함께** 오므로 도착하지 않는다. 스킬 이름을 init에만 기대면 그 세션에서 스킬 전부가 명령
   * 칸에 서고, 카테고리라는 이 기능의 요점이 통째로 무너진다.
   */
  it("splits skills on a session that has never run a turn", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5 }] },
    ], {
      ...CATALOG,
      skills: [{ name: "console-e2e", description: "Drive a headless browser test", argumentHint: "", aliases: [] }],
    });
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-cold", () => freshSeedFor(home));
    // 한 글자도 보내지 않았다 — init은 오지 않았다.
    const catalog = await session.readCatalog();
    expect(catalog!.skills.map((entry) => entry.name)).toEqual(["console-e2e"]);
    expect(catalog!.commands.map((entry) => entry.name)).toEqual(["clear", "compact"]);
    await registry.disposeAll();
  });

  /**
   * init은 카탈로그 control 왕복과 경쟁한다. 분류를 읽을 때 다시 세지 않고 프라임 시점에
   * 굳히면, 늦게 도착한 init의 스킬들이 그 세션 내내 명령 칸에 선다.
   */
  it("classifies skills even when init lands after the catalog round-trip", async () => {
    const home = tempDir("chat-home-");
    const fake = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5 }] },
    ], CATALOG);
    const registry = new AgentChatRegistry(fake.factory);
    const session = await registry.ensure("op-late", () => freshSeedFor(home));
    // 먼저 읽는다 — init은 아직 없고 정책표의 부정 증거만으로 스킬 칸이 선다.
    const before = await session.readCatalog();
    expect(before!.skills.map((entry) => entry.name)).toEqual(["console-e2e"]);
    expect(before!.unclassified).toEqual(["console-e2e"]);
    // 그 뒤에 자식이 init을 흘린다. 긍정 증거가 도착하면 추정이 사실로 굳고 미분류에서 빠진다.
    fake.liveSession()!.emit({ type: "system", subtype: "init", skills: ["console-e2e"], session_id: "s-late" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await session.readCatalog();
    expect(after!.skills.map((entry) => entry.name)).toEqual(["console-e2e"]);
    expect(after!.commands.map((entry) => entry.name)).toEqual(["clear", "compact"]);
    expect(after!.unclassified).toEqual([]);
    await registry.disposeAll();
  });

  /**
   * `null`(못 물었다)과 빈 배열(물었는데 없다)은 다른 상태다. 답하지 않는 자식에서 캐시를
   * 세우면 화면이 "이 세션엔 아무 능력도 없다"를 영구히 그린다.
   */
  it("reports an unreadable catalog as null rather than an empty one", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-null", () => freshSeedFor(home));
    expect(await session.readCatalog()).toBeNull();
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry — maintenance command lane", () => {
  /**
   * 정비 명령은 턴이 아니다. 턴 문법(회전하는 노드·경과 시계·흐르는 글)이 전부 "모델이 생각하고
   * 있다"를 말하는데, 이 셋은 세션 상태를 즉시 바꾸는 동작이고 둘은 모델을 아예 부르지 않는다.
   */
  it("draws /compact as a ledger row with the child's own numbers, never as a turn", async () => {
    const home = tempDir("chat-home-");
    const { factory, sends } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "status", status: "compacting" },
          { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 62400, post_tokens: 18100, duration_ms: 3200 } },
          { type: "result", subtype: "success", is_error: false, duration_ms: 3300, result: "Compacted." },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-compact", () => freshSeedFor(home));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("/compact");
    await drainTurn(registry, "op-compact");

    expect(sends).toEqual(["/compact"]);
    const seen = kinds(events);
    // 말풍선도 턴도 서지 않는다.
    expect(seen).not.toContain("dispatch");
    expect(seen).not.toContain("turn-start");
    expect(seen).not.toContain("turn-end");
    expect(seen).toContain("command");
    expect(seen).toContain("command-progress");
    const end = events.map((entry) => entry.event).find((event) => event.kind === "command-end");
    expect(end).toEqual({ kind: "command-end", ok: true, compact: { before: 62400, after: 18100, durationMs: 3200 } });
    await registry.disposeAll();
  });

  it("empties the ledger when the child confirms the context is gone", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5, result: "OK" }] },
      {
        messages: [
          { type: "conversation_reset" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-clear", () => freshSeedFor(home));
    session.send("say something worth remembering");
    await drainTurn(registry, "op-clear");

    session.send("/clear");
    await drainTurn(registry, "op-clear");

    // 재접속한 브라우저가 받는 것이 곧 화면의 기록이다. 자식이 잊은 대화가 여기 남아 있으면
    // 그것을 읽고 이어 묻는 사람에게 화면이 거짓말을 한다.
    const replayed: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => replayed.push(entry));
    expect(kinds(replayed).filter((kind) => kind === "dispatch")).toEqual([]);
    expect(kinds(replayed)).toContain("cleared");
    await registry.disposeAll();
  });

  it("keeps an unsupported command on the ordinary turn path", async () => {
    // 덱이 세우지 않을 뿐, 손으로 친 것을 막지는 않는다. 그때는 평범한 턴이다 — 우리가 그
    // 결말을 정비 줄로 그릴 근거가 없다.
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5, result: "usage" }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-usage", () => freshSeedFor(home));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("/usage");
    await drainTurn(registry, "op-usage");

    expect(kinds(events)).toContain("dispatch");
    expect(kinds(events)).not.toContain("command");
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry — chat-born sessions", () => {
  it("starts the first turn without a resume coordinate after an empty replay boundary", async () => {
    const home = tempDir("chat-home-");
    const { factory, openSession, sends } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => freshSeedFor(home));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    // 되돌릴 과거가 0턴이라는 사실도 명시적으로 닫힌 경계가 말한다.
    expect(kinds(events)).toEqual(["replay-start", "replay-end", "snapshot-end"]);

    session.send("let us talk about the render path");
    await drainTurn(registry, "op-1");

    expect(sends).toEqual(["let us talk about the render path"]);
    const request = openSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("resume" in request).toBe(false);
    await registry.disposeAll();
  });

  it("opens the session with the Claude Code prompt only when the handle carries it", async () => {
    const home = tempDir("chat-home-");
    const withPrompt = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const withoutPrompt = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);

    const onRegistry = new AgentChatRegistry(withPrompt.factory);
    await onRegistry.ensure("op-on", () => ({
      ...freshSeedFor(home),
      resolveClaudeSession: async () => fakeClaudeSession({ claudeCodeSystemPrompt: "on" }),
    }));
    onRegistry.get("op-on")?.send("hello");
    await drainTurn(onRegistry, "op-on");

    const offRegistry = new AgentChatRegistry(withoutPrompt.factory);
    await offRegistry.ensure("op-off", () => freshSeedFor(home));
    offRegistry.get("op-off")?.send("hello");
    await drainTurn(offRegistry, "op-off");

    const onRequest = withPrompt.openSession.mock.calls[0]?.[0] as Record<string, unknown>;
    const offRequest = withoutPrompt.openSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(onRequest.systemPrompt).toEqual({ mode: "preset" });
    // 필드의 부재가 설정 `off`다 — SDK는 이때 Claude Code 기본 프롬프트를 붙이지 않는다.
    expect("systemPrompt" in offRequest).toBe(false);

    await onRegistry.disposeAll();
    await offRegistry.disposeAll();
  });

  it("publishes the coordinate of the transcript the sdk grew in the shared home", async () => {
    const home = tempDir("chat-home-");
    const updates: unknown[] = [];
    const { configDir } = createFakeSdkFactory([]);
    // 실제 SDK처럼 공유 홈 안에 트랜스크립트를 만든다 — 옮겨 올 사본이 없고, 좌표만 확정된다.
    const openSession = vi.fn(async () => fakeSession([
      {
        messages: [
          { type: "system", subtype: "init", session_id: "born-1" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ], {
      onSend: () => {
        const projectDir = path.join(home, "projects", "-tmp-workspace");
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(path.join(projectDir, "born-1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }));
      },
    }));
    const bornFactory = (vi.fn(async () => ({ configDir, openSession, dispose: async () => {} })) as never);
    const registry = new AgentChatRegistry(bornFactory);
    const session = await registry.ensure("op-1", () => freshSeedFor(home, (providerSession) => updates.push(providerSession)));
    session.send("hello");
    await drainTurn(registry, "op-1");

    // cwd 인코딩을 재구현하지 않는다 — 세션 id로 홈 안을 훑어 우리 파일을 찾는다.
    expect(updates).toEqual([expect.objectContaining({
      harness: "claude-code",
      id: "born-1",
      transcriptPath: path.join(home, "projects", "-tmp-workspace", "born-1.jsonl"),
      source: "chat-mode",
    })]);
    await registry.disposeAll();
  });

  it("hands the sdk the shared home so the transcript grows where the terminal reads it", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-home", () => freshSeedFor(home));
    session.send("go");
    await drainTurn(registry, "op-home");

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      home: { kind: "shared", configDir: home },
    }));
    await registry.disposeAll();
  });

  // 스킬·게이트웨이 정체성·정책 훅은 플러그인 한 벌로 실린다. 설정 층까지 같아야 같은 세션을
  // 터미널로 열었을 때와 능력이 갈리지 않는다.
  it("loads the Fleet plugin and reads the terminal's setting layers", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const resolveClaudeSession = vi.fn(async () => fakeClaudeSession());
    const pluginRoot = "/fleet/workspaces/tmp-workspace/sessions/11111111-2222-4333-8444-555555555555";
    const session = await registry.ensure("op-plugin", () => ({
      ...freshSeedFor(home),
      resolveClaudeSession,
    }));
    session.send("go");
    await drainTurn(registry, "op-plugin");

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      plugins: [{ path: pluginRoot }],
      settingSources: ["user", "project", "local"],
      allowAmbientMcpServers: true,
    }));
    // 좌표는 세션당 한 번만 받는다 — 턴마다 다시 받으면 같은 트리를 매번 새로 렌더한다.
    expect(resolveClaudeSession).toHaveBeenCalledTimes(1);
    // dispose는 트리를 건드리지 않는다 — 트리는 이 세션의 것이고 런치가 접혀도 남는다.
    await registry.disposeAll();
    expect(resolveClaudeSession).toHaveBeenCalledTimes(1);
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
      const registry = new AgentChatRegistry(factory);
      const session = await registry.ensure("op-env", () => freshSeedFor(home));
      session.send("go");
      await drainTurn(registry, "op-env");

      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.not.objectContaining({ FLEET_CONSOLE_SESSION_ID: expect.anything() }),
      }));
      await registry.disposeAll();
    } finally {
      if (previous === undefined) delete process.env.FLEET_CONSOLE_SESSION_ID;
      else process.env.FLEET_CONSOLE_SESSION_ID = previous;
    }
  });

  // 플러그인을 못 실은 세션은 터미널로 열었을 때와 다른, 특히 위임 가드가 없는 능력으로 돈다.
  // 그런 세션을 조용히 계속 돌리는 대신 구체 코드를 남기고 턴을 실패시킨다 — 실패한 턴이
  // 무장 해제된 세션보다 낫다.
  it("surfaces an error and refuses the turn when the Fleet plugin cannot be rendered", async () => {
    const home = tempDir("chat-home-");
    const { factory, openSession } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-plugin-fail", () => ({
      ...freshSeedFor(home),
      resolveClaudeSession: async () => { throw new Error("render failed"); },
    }));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-plugin-fail");

    expect(events.some((entry) => entry.event.kind === "error" && entry.event.code === "chat_fleet_plugin_unavailable")).toBe(true);
    expect(openSession).not.toHaveBeenCalled();
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry", () => {
  it("synthesizes replay boundaries when the journal cap has removed both original markers", async () => {
    const transcriptPath = writeTranscript("sid-capped-boundary", Array.from({ length: 1_100 }, (_, index) => [
      { type: "user", message: { role: "user", content: `order ${index}` } },
      { type: "assistant", message: { content: [{ type: "text", text: `answer ${index}` }] } },
    ]).flat());
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-capped-boundary", () => seedFor(transcriptPath));
    session.send("live after the capped replay");
    await drainTurn(registry, "op-capped-boundary");

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    const snapshot = withoutSnapshotEnd(events);
    expect(snapshot[0]?.event).toEqual({ kind: "replay-start" });
    const replayEnd = snapshot.at(-1)?.event;
    expect(replayEnd).toMatchObject({ kind: "replay-end" });
    const held = snapshot.slice(1, -1).map((entry) => entry.event);
    const dispatches = held.filter((event) => event.kind === "dispatch").length;
    // 합성 경계 안의 원래 replay-end는 live tail보다 먼저 재생을 끝내므로 전달하지 않는다.
    expect(held.some((event) => event.kind === "replay-end")).toBe(false);
    // live 턴의 dispatch/start 쌍도 한 턴이다. 둘을 각각 세면 이 값이 dispatches보다 하나 커진다.
    expect(held.some((event) => event.kind === "turn-start")).toBe(true);
    expect(replayEnd?.kind === "replay-end" ? replayEnd.turns : -1).toBe(dispatches);
    await registry.disposeAll();
  });

  it("counts a mid-turn tail retained at the journal cap", async () => {
    const transcriptPath = writeTranscript("sid-capped-tail", Array.from({ length: 667 }, (_, index) => [
      { type: "user", message: { role: "user", content: `order ${index}` } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: `tool-${index}`, name: "Read", input: { file_path: `file-${index}.ts` } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${index}`, content: "ok" }] } },
    ]).flat());
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-capped-tail", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    const snapshot = withoutSnapshotEnd(events);
    const held = snapshot.slice(1, -1).map((entry) => entry.event);
    expect(held[0]?.kind).not.toBe("dispatch");
    const state = held.reduce((current, event) => reduceAgentChatLog(current, event), {
      ...initialAgentChatLogState,
      replaying: true,
    });
    const replayEnd = snapshot.at(-1)?.event;
    expect(replayEnd?.kind === "replay-end" ? replayEnd.turns : -1).toBe(state.turns.length);
    await registry.disposeAll();
  });

  it("wraps live turns accumulated after the origin replay when reconnecting below the journal cap", async () => {
    const transcriptPath = writeTranscript("sid-reconnect", [
      { type: "user", message: { role: "user", content: "first order" } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-reconnect", () => seedFor(transcriptPath));
    session.send("live before reconnect");
    await drainTurn(registry, "op-reconnect");

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    expect(events[0]?.event).toEqual({ kind: "replay-start" });
    expect(events.at(-2)?.event).toEqual({ kind: "replay-end", turns: 2 });
    expect(events.at(-1)?.event).toMatchObject({ kind: "snapshot-end", turns: expect.any(Number) });
    expect(events.slice(1, -2).some((entry) => entry.event.kind === "replay-end")).toBe(false);
    await registry.disposeAll();
  });

  // Quick Launch 관찰자는 첫 턴이 이미 시작된 뒤에야 붙는다. 그 진행 중 턴까지 재생 경계 안에
  // 넣으면 클라이언트가 재생 turn-start를 done으로 세워, 스트리밍 중인데 "작업함"으로 굳는다.
  // 진행 중 턴의 여는 이벤트는 경계 밖(live)으로 와야 working으로 선다.
  it("streams the in-flight turn live so a mid-turn reconnect renders it working, not done", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      // result가 없어 턴이 닫히지 않는다 — 관찰자가 붙는 순간의 진행 중 턴이다.
      { messages: [{ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-inflight", () => freshSeedFor(home));

    // 첫 구독자로 턴이 열렸으되 아직 닫히지 않은 순간을 잡는다.
    const probe: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => probe.push(entry));
    session.send("start the work");
    await vi.waitFor(() => {
      expect(probe.some((entry) => entry.event.kind === "turn-start")).toBe(true);
      expect(probe.some((entry) => entry.event.kind === "turn-end")).toBe(false);
    });

    // mid-turn으로 재접속하는 두 번째 구독자 — subscribe는 이 순간의 저널을 동기로 되쓴다.
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    const kindsList = kinds(events);
    const endIdx = kindsList.indexOf("replay-end");
    const startIdx = kindsList.indexOf("turn-start");
    // 진행 중 턴의 turn-start는 경계(replay-end) 뒤에 live로 온다.
    expect(endIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(endIdx);

    // 재접속 스냅숏을 리듀스하면 마지막 턴은 done이 아니라 working이다. snapshot-end는 이
    // live 문법의 opener까지가 복원 상태이며, 뒤 이벤트부터 새 도착임을 클라이언트에 말한다.
    const state = events.reduce((current, entry) => reduceAgentChatLog(current, entry.event), initialAgentChatLogState);
    expect(state.turns.at(-1)?.state).toBe("working");
    expect(events.at(-1)?.event).toMatchObject({ kind: "snapshot-end", turns: expect.any(Number) });
    expect(state.snapshotting).toBe(false);

    await registry.disposeAll();
  });

  // 한 진행 중 턴이 상한(2000)을 넘길 만큼 durable 이벤트를 내면 그 턴의 dispatch/turn-start가
  // 저널에서 밀려난다. 그 꼬리를 경계 안에 두면 클라이언트가 done으로 닫고 서버는 새 turn-start를
  // 내지 않아 "끝난 척"으로 굳는다 — 꼬리를 live로 흘리고 합성 turn-start를 앞세워야 working으로 선다.
  it("keeps a capped in-flight tail live with a synthetic turn-start when the opening frames were evicted", async () => {
    const home = tempDir("chat-home-");
    // result가 없어 턴은 열린 채다. 2001개의 text가 저널에 쌓여 dispatch/turn-start를 밀어낸다.
    const messages = Array.from({ length: 2_001 }, (_, i) => ({ type: "assistant", message: { content: [{ type: "text", text: `line ${i}` }] } }));
    const { factory } = createFakeSdkFactory([{ messages }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-capped-inflight", () => freshSeedFor(home));

    const probe: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => probe.push(entry));
    session.send("start a very long turn");
    await vi.waitFor(() => {
      expect(probe.filter((entry) => entry.event.kind === "text").length).toBeGreaterThanOrEqual(2_001);
    }, { timeout: 5_000 });

    // mid-turn 재접속: 재생 스냅숏엔 밀려난 dispatch/turn-start가 없다.
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    const kindsList = kinds(events);
    const endIdx = kindsList.indexOf("replay-end");
    const startIdx = kindsList.indexOf("turn-start");
    // 여는 좌표가 실제로 밀려났음을 못 박는다 — dispatch가 남아 있으면 정상 경로이지 이 상한 경로가
    // 아니다. dispatch 부재 + 경계 뒤 turn-start가 곧 합성 turn-start 경로다.
    expect(kindsList.includes("dispatch")).toBe(false);
    expect(endIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(endIdx);
    // 합성 경계·turn-start는 축을 역행시키지도, 같은 seq로 겹치지도 않는다 — 서로 다른 오름차순
    // 값이라야 seq<=lastSeq로 거르는 소비자가 경계·opener·첫 내용을 버리지 않는다.
    const seqs = events.map((entry) => entry.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
    }
    // 리듀스하면 마지막 턴은 done이 아니라 working이다.
    const state = events.reduce((current, entry) => reduceAgentChatLog(current, entry.event), initialAgentChatLogState);
    expect(state.turns.at(-1)?.state).toBe("working");

    await registry.disposeAll();
  });

  // resume 트랜스크립트의 마지막 턴은 소요 시간 좌표가 없으면 turn-end 없이 남는다. 그 뒤 라이브
  // 턴이 돌 때 mid-turn 재접속하면, 진행 중 턴의 시작을 "마지막 turn-end 뒤"로만 찾으면 그 과거
  // 마지막 턴의 opener를 골라 경계 밖으로 흘려 버린다 — 지난 턴이 새로 도착한 것으로 읽힌다.
  it("splits at the live opener, not a turn-end-less historical turn, on a mid-turn reconnect", async () => {
    const transcriptPath = writeTranscript("sid-resume-noend", [
      { type: "user", timestamp: "2026-08-23T00:00:00.000Z", message: { role: "user", content: "first order" } },
      { type: "assistant", timestamp: "2026-08-23T00:00:05.000Z", message: { content: [{ type: "text", text: "reply one" }] } },
      // 마지막 과거 턴: 시각 차가 없어 turn-end가 서지 않는다.
      { type: "user", timestamp: "2026-08-23T00:01:00.000Z", message: { role: "user", content: "HISTORIC last" } },
      { type: "assistant", timestamp: "2026-08-23T00:01:00.000Z", message: { content: [{ type: "text", text: "hist reply" }] } },
    ]);
    const { factory } = createFakeSdkFactory([
      // result가 없어 라이브 턴은 열린 채다.
      { messages: [{ type: "assistant", message: { content: [{ type: "text", text: "live streaming" }] } }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-resume-noend", () => seedFor(transcriptPath));

    const probe: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => probe.push(entry));
    session.send("LIVEPROMPT");
    await vi.waitFor(() => {
      expect(probe.some((entry) => entry.event.kind === "dispatch"
        && (entry.event as { readonly text?: string }).text === "LIVEPROMPT")).toBe(true);
      expect(probe.some((entry) => entry.event.kind === "turn-start")).toBe(true);
    });

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    const endIdx = events.findIndex((entry) => entry.event.kind === "replay-end");
    const after = events.slice(endIdx + 1).map((entry) => entry.event);
    // 경계 뒤엔 라이브 턴만 온다 — 과거 마지막 턴(HISTORIC)의 dispatch가 새로 도착하지 않는다.
    const dispatchesAfter = after.filter((event) => event.kind === "dispatch") as { readonly text: string }[];
    expect(dispatchesAfter.map((event) => event.text)).toEqual(["LIVEPROMPT"]);
    // 리듀스하면 마지막 턴은 working이고, 과거 턴은 재생 안이라 done이다.
    const state = events.reduce((current, entry) => reduceAgentChatLog(current, entry.event), initialAgentChatLogState);
    expect(state.turns.at(-1)?.state).toBe("working");
    expect(state.turns.at(-1)?.dispatch?.text).toBe("LIVEPROMPT");

    await registry.disposeAll();
  });

  it("replays the origin transcript into the journal on ensure", async () => {
    const transcriptPath = writeTranscript("sid-1", [
      { type: "user", message: { role: "user", content: "first order" } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    expect(kinds(events)).toEqual(["replay-start", "dispatch", "text", "replay-end", "snapshot-end"]);
    await registry.disposeAll();
  });

  // 주입 운반체는 말풍선 없는 여는 이벤트로 온다. 그것을 곧바로 턴으로 세우면 두 가지가 어긋난다:
  // 한 번의 슬래시 명령이 여러 줄로 와서 턴이 쪼개지고, 뒤에 아무것도 안 오는 운반체가 화면에는
  // 없는 턴을 카운트에만 남긴다. 그래서 여는 이벤트는 내용이 따라올 때 비로소 발행된다.
  it("defers a carrier's turn until content follows, and folds a run of carriers into one", async () => {
    const transcriptPath = writeTranscript("sid-carrier", [
      { type: "user", timestamp: "2026-08-18T01:00:00.000Z", message: { role: "user", content: "first order" } },
      { type: "assistant", timestamp: "2026-08-18T01:00:05.000Z", message: { content: [{ type: "text", text: "워크플로를 띄웠습니다." }] } },
      // 한 번의 슬래시 명령이 세 줄로 온다 — 턴 하나만 열려야 한다.
      { type: "user", timestamp: "2026-08-18T01:01:00.000Z", message: { role: "user", content: "<command-message>goal</command-message>\n<command-name>/goal</command-name>" } },
      { type: "user", timestamp: "2026-08-18T01:01:00.500Z", message: { role: "user", content: "<local-command-stdout>Goal set</local-command-stdout>" } },
      { type: "assistant", timestamp: "2026-08-18T01:01:09.000Z", message: { content: [{ type: "text", text: "목표 확인했습니다." }] } },
      // 뒤에 아무 내용도 따르지 않는 운반체 — 턴을 세우지 않는다.
      { type: "user", timestamp: "2026-08-18T01:02:00.000Z", message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" } },
    ]);
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-carrier", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    expect(kinds(events)).toEqual([
      "replay-start",
      "dispatch", "text", "turn-end",
      "turn-start", "text", "turn-end",
      "replay-end", "snapshot-end",
    ]);
    // 접힌 턴의 시작은 묶음의 첫 줄이고, 끝맺지 못한 운반체는 앞 턴의 끝을 늘리지 않는다.
    expect(events.map((entry) => entry.event).filter((event) => event.kind === "turn-end")).toEqual([
      { kind: "turn-end", ok: true, durationMs: 5_000 },
      { kind: "turn-end", ok: true, durationMs: 9_000 },
    ]);
    const end = events.map((entry) => entry.event).find((event) => event.kind === "replay-end");
    expect(end).toEqual({ kind: "replay-end", turns: 2 });
    await registry.disposeAll();
  });

  // 재생 턴에는 SDK result가 없다 — 소요 시간은 트랜스크립트 줄의 시각에서 나온다.
  // 이것이 없으면 접힘 줄이 과거 턴에서만 시간을 잃고 "작업함"으로 주저앉는다.
  it("derives each replayed turn's duration from its transcript timestamps", async () => {
    const transcriptPath = writeTranscript("sid-dur", [
      { type: "user", timestamp: "2026-08-15T01:00:00.000Z", message: { role: "user", content: "first order" } },
      { type: "assistant", timestamp: "2026-08-15T01:00:12.500Z", message: { content: [{ type: "text", text: "done" }] } },
      { type: "user", timestamp: "2026-08-15T01:05:00.000Z", message: { role: "user", content: "second order" } },
      { type: "assistant", timestamp: "2026-08-15T01:05:03.000Z", message: { content: [{ type: "text", text: "done again" }] } },
    ]);
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-dur", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    const ends = events.map((entry) => entry.event).filter((event) => event.kind === "turn-end");
    expect(ends).toEqual([
      { kind: "turn-end", ok: true, durationMs: 12_500 },
      { kind: "turn-end", ok: true, durationMs: 3_000 },
    ]);
    await registry.disposeAll();
  });

  // 시각이 없는 트랜스크립트에서 0초짜리 턴을 지어내지 않는다.
  it("stays silent about duration when the transcript carries no timestamps", async () => {
    const transcriptPath = writeTranscript("sid-nodur", [
      { type: "user", message: { role: "user", content: "first order" } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-nodur", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    expect(kinds(events)).not.toContain("turn-end");
    await registry.disposeAll();
  });

  it("resumes with the session id the origin transcript's file name carries", async () => {
    const transcriptPath = writeTranscript("sid-2", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, openSession, sends } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    session.send("continue");
    await drainTurn(registry, "op-1");

    // 프롬프트는 세션 옵션이 아니라 `send()`가 싣는다 — 세션 하나가 여러 프롬프트를 받는다.
    expect(sends).toEqual(["continue"]);
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({
      resume: "sid-2",
      model: "opus[1m]",
      effort: "high",
      cwd: "/tmp/workspace",
      permissionMode: "bypassPermissions",
      // 글자 단위 스트리밍의 전제 — text_delta는 부분 메시지에만 실린다.
      includePartialMessages: true,
    }));
    expect(openSession.mock.calls[0]?.[0]).not.toHaveProperty("prompt");
    await registry.disposeAll();
  });

  it("forwards session ultracode into the SDK factory, not as a turn effort rung", async () => {
    const transcriptPath = writeTranscript("sid-ultra", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, openSession } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ultra", () => ({
      ...seedFor(transcriptPath),
      effort: "xhigh",
      ultracode: true,
    }));
    session.send("continue");
    await drainTurn(registry, "op-ultra");

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ ultracode: true }));
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ effort: "xhigh" }));
    expect(openSession.mock.calls[0]?.[0]).not.toHaveProperty("ultracode");
    await registry.disposeAll();
  });

  // 델타는 라이브 전용이다 — 저널(cap 2000)에 실으면 즉시 소진되므로, 재접속 리플레이는
  // 완성 text 이벤트(병합본)로 같은 내용을 복원한다.
  it("streams deltas to live subscribers but keeps them out of the journal", async () => {
    const transcriptPath = writeTranscript("sid-d", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory } = createFakeSdkFactory([
      { messages: [
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        { type: "result", subtype: "success", is_error: false, duration_ms: 4, result: "Hello" },
      ] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-delta", () => seedFor(transcriptPath));
    const live: AgentChatJournalEvent[] = [];
    const unsubscribe = session.subscribe((entry) => live.push(entry));
    session.send("go");
    await drainTurn(registry, "op-delta");
    unsubscribe();

    expect(kinds(live).filter((kind) => kind === "text-delta")).toHaveLength(2);
    expect(live.map((entry) => entry.event)).toContainEqual({ kind: "turn-end", ok: true, durationMs: 4, answer: "Hello" });

    const replayed: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => replayed.push(entry))();
    expect(kinds(replayed)).not.toContain("text-delta");
    expect(replayed.map((entry) => entry.event)).toContainEqual({ kind: "text", text: "Hello" });
    await registry.disposeAll();
  });

  it("reports the provider session for the transcript the sdk grew in place", async () => {
    const transcriptPath = writeTranscript("sid-3", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const updates: unknown[] = [];
    // 공유 홈에서는 SDK가 원본 파일을 그대로 키운다 — 복사해 들어갈 사본도, 되쓸 목적지도 없다.
    const factory = (async () => ({
      configDir: homeOf(transcriptPath),
      models: ["opus[1m]"],
      openSession: async () => fakeSession([
        {
          messages: [
            { type: "system", subtype: "init", session_id: "sid-3" },
            { type: "result", subtype: "success", is_error: false },
          ],
        },
      ], {
        onSend: () => {
          writeFileSync(transcriptPath, `${readFileSync(transcriptPath, "utf8")}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "grown" }] } })}`);
        },
      }),
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath, (providerSession) => updates.push(providerSession)));

    session.send("continue");
    await drainTurn(registry, "op-1");

    expect(readFileSync(transcriptPath, "utf8")).toContain("grown");
    expect(updates.at(-1)).toEqual(expect.objectContaining({
      harness: "claude-code",
      id: "sid-3",
      transcriptPath,
      source: "chat-mode",
    }));
    await registry.disposeAll();
  });

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

  // 이 결함이 조용했던 이유는 턴이 도는데 활동축이 그것을 모르는 상태가 성립했기 때문이다.
  // 축이 보고를 받지 못하면 일을 시작하지 않는 쪽을 고른다 — 그래야 실패가 시끄럽다.
  it("refuses to start a turn when the activity axis cannot take the report", async () => {
    const transcriptPath = writeTranscript("sid-activity", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, openSession } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => ({ ...seedFor(transcriptPath), reportActivity: () => false, canReportActivity: () => false }));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    expect(session.canReportActivity()).toBe(false);
    session.send("first");
    await drainTurn(registry, "op-1");

    expect(openSession).not.toHaveBeenCalled();
    expect(events.some((entry) => entry.event.kind === "error" && entry.event.code === "chat_activity_unavailable")).toBe(true);
    expect(events.some((entry) => entry.event.kind === "turn-end" && entry.event.ok === false)).toBe(true);
    await registry.disposeAll();
  });

  it("probes the activity axis without writing a transition", async () => {
    const transcriptPath = writeTranscript("sid-probe", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
    ]);
    const reported: boolean[] = [];
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => ({
      ...seedFor(transcriptPath),
      reportActivity: (working: boolean) => { reported.push(working); return true; },
      canReportActivity: () => true,
    }));

    expect(session.canReportActivity()).toBe(true);
    // 확인만으로는 축에 아무것도 쓰이지 않아야 한다 — 쓰면 진행 중인 턴이 유휴로 방송된다.
    expect(reported).toEqual([]);
    await registry.disposeAll();
  });

  it("reports working around the SDK turn and clears it on both success and failure", async () => {
    const transcriptPath = writeTranscript("sid-pulse", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
      { messages: [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }], failAfter: 1 },
    ]);
    const reported: boolean[] = [];
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => ({
      ...seedFor(transcriptPath),
      reportActivity: (working: boolean) => { reported.push(working); return true; },
      canReportActivity: () => true,
    }));

    session.send("first");
    await drainTurn(registry, "op-1");
    expect(reported).toEqual([true, false]);

    // 실패한 턴도 종료 pulse 를 남긴다 — 남기지 않으면 축이 영영 running 으로 굳는다.
    session.send("second");
    await drainTurn(registry, "op-1");
    expect(reported).toEqual([true, false, true, false]);
    await registry.disposeAll();
  });

  // 좌표 조회는 파일을 읽으므로 한 턴의 프레임 여러 개가 같은 비행에 겹친다. 그 사이에 세션
  // id가 바뀌면(자식이 이어붙이며 새 id를 낳는다) 삼켜진 요청이 나르던 것이 바로 최신 좌표다 —
  // 그 프레임이 마지막이면 Operation은 옛 좌표를 durable 권위로 들고 남는다.
  it("retries the coordinate lookup that arrived while the first one was in flight", async () => {
    const home = tempDir("chat-home-");
    const updates: Array<{ readonly id: string }> = [];
    const configDir = tempDir("chat-sdk-");
    const projectDir = path.join(home, "projects", "-tmp-workspace");
    mkdirSync(projectDir, { recursive: true });
    for (const id of ["sid-first", "sid-latest"]) {
      writeFileSync(path.join(projectDir, `${id}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));
    }
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      openSession: async () => fakeSession([
        {
          messages: [
            // 첫 조회가 여기서 뜬다.
            { type: "system", subtype: "init", session_id: "sid-first" },
            // 그 비행 중에 새 id가 도착한다. 삼켜지면 이 좌표는 다시 요청되지 않는다.
            { type: "result", subtype: "success", is_error: false, duration_ms: 3, session_id: "sid-latest" },
          ],
        },
      ]),
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-sync-retry", () => freshSeedFor(home, (providerSession) => updates.push(providerSession as { id: string })));

    session.send("go");
    await drainTurn(registry, "op-sync-retry");

    await vi.waitFor(() => {
      expect(updates.at(-1)?.id).toBe("sid-latest");
    });
    await registry.disposeAll();
  });

  it("skips the provider session update when no transcript carries the session id", async () => {
    const transcriptPath = writeTranscript("sid-6", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const updates: unknown[] = [];
    const factory = (async () => ({
      configDir: homeOf(transcriptPath),
      models: ["opus[1m]"],
      openSession: async () => fakeSession([
        { messages: [{ type: "result", subtype: "success", is_error: false }] },
      ], {
        onSend: () => {
          // 턴은 돌았지만 그 세션의 파일이 홈 어디에도 없다 — 밖에서 치워진 상황이다. 없는 파일을
          // durable 권위로 심으면 터미널 복귀와 Analyst가 조용히 세션을 잃는다.
          rmSync(path.dirname(transcriptPath), { recursive: true, force: true });
        },
      }),
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath, (providerSession) => updates.push(providerSession)));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("continue");
    await drainTurn(registry, "op-1");

    expect(updates).toEqual([]);
    expect(events.some((entry) => entry.event.kind === "error")).toBe(false);
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

  it("dispose closes a stalled active turn instead of waiting for it", async () => {
    const transcriptPath = writeTranscript("sid-8", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    // 아무것도 돌려주지 않는 자식 — 세션 스트림은 close 전까지 끝나지 않으므로 그것이 유일한
    // 탈출구다(실 SDK 계약과 같다).
    const stalled = fakeSession([{ messages: [] }]);
    const factory = (async () => ({
      configDir: tempDir("chat-sdk-"),
      models: ["opus[1m]"],
      openSession: async () => stalled,
      dispose: async () => { stalled.close(); },
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    session.send("stalls forever");
    await vi.waitFor(() => {
      expect(registry.isBusy("op-1")).toBe(true);
    });

    // 순서가 뒤집혀 있으면(턴 완주 대기 → sdk.dispose) 여기서 영원히 멈춘다.
    await registry.dispose("op-1");
    expect(registry.has("op-1")).toBe(false);
  });

  it("rejects a new ensure while disposal is in progress", async () => {
    const transcriptPath = writeTranscript("sid-9", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    let releaseDispose: () => void = () => {};
    const factory = (async () => ({
      configDir: tempDir("chat-sdk-"),
      models: ["opus[1m]"],
      openSession: async () => { throw new Error("unused"); },
      dispose: async () => new Promise<void>((resolve) => { releaseDispose = resolve; }),
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    // sdk를 실제로 만들어 두어야 dispose가 sdk.dispose에서 머문다.
    session.send("boot the sdk");
    await drainTurn(registry, "op-1");

    const disposal = registry.dispose("op-1");
    await expect(registry.ensure("op-1", () => seedFor(transcriptPath))).rejects.toThrow("chat_session_disposing");
    releaseDispose();
    await disposal;
    // dispose가 끝난 뒤에는 다시 만들 수 있다(모드 재진입).
    const recreated = await registry.ensure("op-1", () => seedFor(transcriptPath));
    expect(recreated).toBeTruthy();
    await registry.disposeAll();
  });

  it("reports busy while a turn is in flight", async () => {
    const transcriptPath = writeTranscript("sid-5", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const configDir = tempDir("chat-sdk-");
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      // 문이 열릴 때까지 자식이 아무 말도 하지 않는다 — 그동안 세션은 busy여야 한다.
      openSession: async () => {
        const gated = fakeSession([{ messages: [{ type: "result", subtype: "success", is_error: false }] }]);
        return { ...gated, send: (text: string) => { void gate.then(() => gated.send(text)); } };
      },
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    session.send("long turn");
    await vi.waitFor(() => {
      expect(registry.isBusy("op-1")).toBe(true);
    });
    release();
    await drainTurn(registry, "op-1");
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry — background follow-up turns", () => {
  it("closes the follow-up turn when the session ends without a second result", async () => {
    // 백그라운드 작업이 끝나 모델이 다시 말하기 시작했지만, 두 번째 result가 오기 전에 세션이
    // 끝난다. 이때 아무도 그 턴을 닫지 않으면 원장에 영원히 도는 스피너가 남는다.
    const transcriptPath = writeTranscript("sid-follow-1", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the workflow finished" }] } },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-1", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-1");
    // 후속 턴은 디스패치 없이 열린다 — 그것이 백그라운드가 끝나 모델이 다시 깨어난 자리다.
    await vi.waitFor(() => { expect(kinds(events)).toContain("text"); });
    // 세션이 접히는 것이 그 턴의 결말이다. 자식이 사라졌는데 스피너를 남겨 두지 않는다.
    await registry.disposeAll();

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end", "turn-start", "text", "turn-end"]);
  });

  it("closes the follow-up turn when the stream throws after it opened", async () => {
    const transcriptPath = writeTranscript("sid-follow-2", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the workflow finished" }] } },
        ],
        failAfter: 2,
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-2", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-2");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end", "turn-start", "text", "error", "turn-end"]);
    const last = events.at(-1)?.event;
    expect(last).toEqual({ kind: "turn-end", ok: false });
    await registry.disposeAll();
  });

  it("does not close a turn twice when the stream ends right after its result", async () => {
    const transcriptPath = writeTranscript("sid-follow-3", []);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-3", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-3");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end"]);
    await registry.disposeAll();
  });

  it("does not open a turn for nested subagent frames that arrive after the turn closed", async () => {
    // 서브에이전트 도구·텍스트는 부모 스트림에 parent_tool_use_id를 달고 온다. 턴이 닫힌 뒤에
    // 그것이 오면 opensChatTurn이 새 턴을 열고, 서브에이전트 보고가 메인 Answer처럼 선다.
    const transcriptPath = writeTranscript("sid-follow-nested", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "result", subtype: "success", is_error: false, duration_ms: 10, result: "launched" },
          {
            type: "assistant",
            parent_tool_use_id: "task-1",
            message: { role: "assistant", content: [{ type: "text", text: "the subagent finished" }] },
          },
          {
            type: "assistant",
            parent_tool_use_id: "task-1",
            message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "src/a.ts" } }] },
          },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-nested", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-nested");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end"]);
    expect(events.map((entry) => entry.event)).not.toContainEqual(
      expect.objectContaining({ kind: "text", text: "the subagent finished" }),
    );
    await registry.disposeAll();
  });

  it("does not open a turn for background pulses that arrive after the turn closed", async () => {
    // 맥박은 턴이 닫힌 뒤에도 계속 흐르는 것이 정상이다 — 그것으로 턴을 열면 빈 턴이 선다.
    const transcriptPath = writeTranscript("sid-follow-4", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
          { type: "system", subtype: "task_progress", task_id: "w1", usage: { total_tokens: 5, tool_uses: 0, duration_ms: 9 } },
          { type: "system", subtype: "task_notification", task_id: "w1", status: "completed", summary: "done" },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-4", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-4");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end", "job-progress", "job-end"]);
    await registry.disposeAll();
  });
});

/**
 * 백그라운드 작업이 세션의 것이 되면서 생긴 계약들.
 *
 * 요점은 수명이다 — 자식이 사는 동안 잡도 살고, 자식이 사라지면 잡도 사라진다. 원장은 그
 * 두 사실을 모두 말해야 하며, 어느 쪽도 지어내지 않아야 한다.
 */
describe("AgentChatRegistry — background jobs on a live session", () => {
  it("leaves a background job running after the turn that started it closes", async () => {
    const transcriptPath = writeTranscript("sid-job-live", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "sh1", description: "poll", task_type: "local_bash" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-job-live", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("start the poll");
    await drainTurn(registry, "op-job-live");

    // 턴은 닫혔고, 잡은 결말을 받지 않았다 — 그것이 백그라운드 작업의 정의다.
    expect(events.some((entry) => entry.event.kind === "turn-end")).toBe(true);
    expect(kinds(events)).not.toContain("job-end");
    await registry.disposeAll();
  });

  it("titles a live job from the tool call that started it, not from the notification's copy", async () => {
    // 실사용 제보(2026-08-27, Windows 한국어): 채팅뷰의 잡 카드 제목만 CJK가 깨져 섰다.
    // 어시스턴트 본문은 멀쩡했으므로 자식에게 닿은 바이트는 온전했고, 깨진 것은 자식이 자기
    // 태스크 레코드에서 다시 꺼낸 사본뿐이었다. 화면은 모델이 쓴 그 문장을 읽어야 한다.
    const transcriptPath = writeTranscript("sid-job-title", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "call-9",
                name: "Bash",
                input: { command: "echo hi", description: "WORLD 공간 조회", run_in_background: true },
              }],
            },
          },
          {
            type: "system", subtype: "task_started",
            task_id: "sh9", tool_use_id: "call-9", description: "WORLD 怨듦컙 議고쉶", task_type: "local_bash",
          },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-job-title", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("run it in the background");
    await drainTurn(registry, "op-job-title");

    const job = events.find((entry) => entry.event.kind === "job");
    expect(job?.event).toEqual(expect.objectContaining({ kind: "job", id: "sh9", title: "WORLD 공간 조회" }));
    await registry.disposeAll();
  });

  it("closes still-running jobs as stopped when the session goes away", async () => {
    // 자식과 함께 사라진 작업을 "도는 중"으로 남겨 두면 화면은 오지 않을 결말을 기다린다.
    const transcriptPath = writeTranscript("sid-job-retire", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "sh2", description: "poll", task_type: "local_bash" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-job-retire", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("start the poll");
    await drainTurn(registry, "op-job-retire");
    await registry.disposeAll();

    expect(events.map((entry) => entry.event)).toContainEqual({ kind: "job-end", id: "sh2", status: "stopped" });
  });

  /**
   * 원장과 활동축을 잇는 계약.
   *
   * 턴이 닫혀도 서브에이전트·워크플로는 계속 돈다. 그 구간을 유휴로 그리면 사용자는 끝나지 않은
   * 일을 끝난 것으로 읽는다 — 그래서 원장이 바뀔 때마다 축에 절대값을 보고한다. 셸은 이 축에
   * 서지 않는다: 긴 백그라운드 명령 하나가 세션을 영영 유휴 밖에 세워 둔다.
   */
  it("raises the background axis when an agent job outlives the turn that started it", async () => {
    const transcriptPath = writeTranscript("sid-bg-agent", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "ag1", description: "map the tree", task_type: "local_agent" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-agent", () => pendingSeedFor(transcriptPath, pending));

    session.send("map it");
    await drainTurn(registry, "op-bg-agent");

    expect(transitions(pending)).toEqual([true]);
    await registry.disposeAll();
  });

  it("keeps the background axis down while only a shell job is running", async () => {
    const transcriptPath = writeTranscript("sid-bg-shell", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "sh4", description: "tail the log", task_type: "local_bash" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-shell", () => pendingSeedFor(transcriptPath, pending));

    session.send("tail it");
    await drainTurn(registry, "op-bg-shell");

    // 셸은 알아본 결과가 "에이전트 작업 없음"이므로 무의견이 아니라 확정된 false다.
    expect(transitions(pending)).toEqual([false]);
    await registry.disposeAll();
  });

  it("drops the background axis when the last agent job reports its end", async () => {
    const transcriptPath = writeTranscript("sid-bg-end", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "wf1", description: "review", task_type: "local_workflow" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
          { type: "system", subtype: "task_notification", task_id: "wf1", status: "completed", summary: "done" },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-end", () => pendingSeedFor(transcriptPath, pending));

    session.send("review it");
    await drainTurn(registry, "op-bg-end");

    await vi.waitFor(() => {
      expect(transitions(pending)).toEqual([true, false]);
    });
    await registry.disposeAll();
  });

  // REPLACE 목록은 종류를 싣고 오지만 스트림 이벤트는 id만 나른다. 목록에서 처음 본 잡의
  // 종류를 읽지 않으면 셸 하나가 이 축을 세운다.
  it("reads job kinds off the replace list so a shell it introduces stays off the axis", async () => {
    const transcriptPath = writeTranscript("sid-bg-replace", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "sh5", task_type: "local_bash", description: "tail" }],
          },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-replace", () => pendingSeedFor(transcriptPath, pending));

    session.send("go");
    await drainTurn(registry, "op-bg-replace");

    expect(transitions(pending)).toEqual([false]);
    await registry.disposeAll();
  });

  it("raises the axis when the replace list carries an agent job beside a shell one", async () => {
    const transcriptPath = writeTranscript("sid-bg-replace-mixed", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              { task_id: "sh6", task_type: "local_bash", description: "tail" },
              { task_id: "ag2", task_type: "local_agent", description: "map" },
            ],
          },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-replace-mixed", () => pendingSeedFor(transcriptPath, pending));

    session.send("go");
    await drainTurn(registry, "op-bg-replace-mixed");

    expect(transitions(pending)).toEqual([true]);
    await registry.disposeAll();
  });

  // 이 축에는 시한이 없으므로 무의견은 영원이 된다 — 상주하는 미지 잡 하나가 배지를 영영 켜 두지
  // 않도록, 알아본 에이전트 작업이 없으면 그대로 해제한다.
  it("does not raise the axis for a job of an unrecognized kind", async () => {
    const transcriptPath = writeTranscript("sid-bg-other", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "ot1", description: "watch", task_type: "local_hologram" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-other", () => pendingSeedFor(transcriptPath, pending));

    session.send("watch it");
    await drainTurn(registry, "op-bg-other");

    expect(transitions(pending)).toEqual([false]);
    await registry.disposeAll();
  });

  // 이름 붙은 에이전트는 결말을 낸 뒤에도 다음 지시를 기다리며 목록에 실려 온다. 그 항목을 다시
  // 살아 있는 작업으로 읽으면, 시한이 없는 이 축은 세션이 끝날 때까지 풀리지 않는다.
  it("keeps a resident agent off the axis once its end event has arrived", async () => {
    const transcriptPath = writeTranscript("sid-bg-resident", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "ag5", description: "probe", task_type: "local_agent" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
          { type: "system", subtype: "task_notification", task_id: "ag5", status: "completed", summary: "done" },
          {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "ag5", task_type: "local_agent", description: "probe" }],
          },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-resident", () => pendingSeedFor(transcriptPath, pending));

    session.send("probe it");
    await drainTurn(registry, "op-bg-resident");

    await vi.waitFor(() => {
      expect(transitions(pending)).toEqual([true, false]);
    });
    await registry.disposeAll();
  });

  // 목록 행이 종류를 싣지 않는 것은 종류에 대해 침묵한 것이지, 종류가 없다는 뜻이 아니다.
  it("does not let a kindless replace row erase a kind it already knew", async () => {
    const transcriptPath = writeTranscript("sid-bg-kindless", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "wf2", description: "review", task_type: "local_workflow" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
          { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "wf2", description: "review" }] },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-kindless", () => pendingSeedFor(transcriptPath, pending));

    session.send("review it");
    await drainTurn(registry, "op-bg-kindless");

    await vi.waitFor(() => {
      expect(transitions(pending)).toEqual([true]);
    });
    await registry.disposeAll();
  });

  // 이 축은 두 어댑터가 같은 필드에 쓴다. 죽어가는 PTY의 마지막 정리나 뒤늦은 hook 하나가 채팅이 세운
  // 값을 지울 수 있고, 잡 원장은 다음 잡이 뜨거나 끝날 때까지 다시 말하지 않는다. 그래서 턴이 닫히는
  // 순간 — 이 축이 화면에 나타나는 바로 그 순간 — 절대값을 다시 말한다.
  it("restates the axis when the turn closes, not only when the ledger changes", async () => {
    const transcriptPath = writeTranscript("sid-bg-restate", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "ag7", description: "map", task_type: "local_agent" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-restate", () => pendingSeedFor(transcriptPath, pending));

    session.send("map it");
    await drainTurn(registry, "op-bg-restate");

    // 원장은 한 번 바뀌었지만 보고는 두 번이다 — 두 번째가 턴 종료의 재천명이다.
    expect(pending).toEqual([true, true]);
    await registry.disposeAll();
  });

  // 상주 에이전트가 다시 일을 받으면 그 좌표는 더 이상 끝난 잡이 아니다. 기억을 남겨 두면 바로 다음
  // 목록이 지금 일하는 에이전트를 상주 항목으로 오인해 축에서 지운다.
  it("clears the settled memory when the same job starts again", async () => {
    const transcriptPath = writeTranscript("sid-bg-restart", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "ag8", description: "probe", task_type: "local_agent" },
          { type: "system", subtype: "task_notification", task_id: "ag8", status: "completed", summary: "done" },
          { type: "system", subtype: "task_started", task_id: "ag8", description: "probe again", task_type: "local_agent" },
          {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "ag8", task_type: "local_agent", description: "probe again" }],
          },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-restart", () => pendingSeedFor(transcriptPath, pending));

    session.send("probe it");
    await drainTurn(registry, "op-bg-restart");

    await vi.waitFor(() => {
      expect(transitions(pending)).toEqual([true, false, true]);
    });
    await registry.disposeAll();
  });

  it("drops the background axis when the session that owned the jobs goes away", async () => {
    const transcriptPath = writeTranscript("sid-bg-retire", []);
    const pending: boolean[] = [];
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "ag3", description: "map", task_type: "local_agent" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-bg-retire", () => pendingSeedFor(transcriptPath, pending));

    session.send("map it");
    await drainTurn(registry, "op-bg-retire");
    expect(transitions(pending)).toEqual([true]);

    await registry.disposeAll();
    expect(transitions(pending)).toEqual([true, false]);
  });

  // 자식이 startup에서 죽으면 리더는 `ensureSession()`이 해소된 직후에 끝난다. 그 사이에 낀
  // 디스패치가 폐기된 세션에 프롬프트를 보내면 그것은 조용히 버려지고, 대기를 건 큐는 오지 않을
  // 결말을 영영 기다린다.
  it("does not arm a waiter on a session that was retired while it was being opened", async () => {
    const transcriptPath = writeTranscript("sid-race-retire", []);
    const configDir = tempDir("chat-sdk-");
    const sends: string[] = [];
    let opened = 0;
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      openSession: async () => {
        const session = fakeSession(
          opened++ === 0
            ? []
            : [{ messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] }],
          { onSend: (text) => sends.push(text) },
        );
        // 첫 자식은 열리자마자 죽는다 — 리더는 곧바로 스트림 끝을 본다.
        if (opened === 1) session.close();
        return session;
      },
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-race-retire", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("first");
    await drainTurn(registry, "op-race-retire");
    expect(events.some((entry) => entry.event.kind === "turn-end" && entry.event.ok === false)).toBe(true);

    // 큐가 막히지 않았다 — 다음 메시지가 새 자식 위에서 정상으로 돈다.
    session.send("second");
    await drainTurn(registry, "op-race-retire");
    expect(sends).toEqual(["second"]);
    await registry.disposeAll();
  });

  it("routes a job stop to the child and refuses a coordinate it never issued", async () => {
    const transcriptPath = writeTranscript("sid-job-stop", []);
    const stopped: string[] = [];
    const configDir = tempDir("chat-sdk-");
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      openSession: async () => fakeSession([
        {
          messages: [
            { type: "system", subtype: "task_started", task_id: "sh3", description: "poll", task_type: "local_bash" },
            { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
          ],
        },
      ], { onStopTask: (taskId) => stopped.push(taskId) }),
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-job-stop", () => seedFor(transcriptPath));

    session.send("start the poll");
    await drainTurn(registry, "op-job-stop");

    expect(await session.stopJob("sh3")).toBe(true);
    expect(stopped).toEqual(["sh3"]);
    // 브라우저가 건네는 유일한 값이다 — 발급된 적 없는 좌표는 자식에 닿지 않는다.
    expect(await session.stopJob("never-issued")).toBe(false);
    expect(await session.stopJob("../../etc/passwd")).toBe(false);
    expect(stopped).toEqual(["sh3"]);
    await registry.disposeAll();
  });

  // 자식이 스스로 깨어나 연 턴은 아무도 기다리지 않는다. 그 창에 들어온 사용자 메시지가 그
  // 턴에 올라타면, 남의 `result`가 그 디스패치를 풀어 아직 답하지도 않은 프롬프트를 끝난 것으로
  // 그리고, 큐의 다음 메시지가 그 위에서 조기에 시작한다.
  it("waits for a background-woken turn to close before dispatching the next message", async () => {
    const transcriptPath = writeTranscript("sid-turn-overlap", []);
    const { factory, liveSession, sends } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5 }] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 5 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-turn-overlap", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("first");
    await drainTurn(registry, "op-turn-overlap");

    // 백그라운드가 끝나 모델이 다시 깨어났다 — 디스패치 없는 턴이 열리고, 아직 닫히지 않았다.
    liveSession()?.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the workflow finished" }] } });
    await vi.waitFor(() => { expect(kinds(events)).toContain("text"); });

    session.send("second");
    // 그 턴이 닫히기 전에는 두 번째 프롬프트가 자식에 닿지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sends).toEqual(["first"]);
    expect(kinds(events).filter((kind) => kind === "dispatch")).toHaveLength(1);

    // 후속 턴이 자기 결말을 내면 그때 자리가 난다.
    liveSession()?.emit({ type: "result", subtype: "success", is_error: false, duration_ms: 3 });
    await drainTurn(registry, "op-turn-overlap");

    expect(sends).toEqual(["first", "second"]);
    const starts = kinds(events).filter((kind) => kind === "turn-start").length;
    const ends = kinds(events).filter((kind) => kind === "turn-end").length;
    expect(starts).toBe(ends);
    await registry.disposeAll();
  });

  // 스트림이 끝난 것과 슬롯이 반납된 것은 다른 사건이다. 닫지 않고 버리면 다음 메시지의
  // openSession이 거절되고, 그 Operation은 dispose될 때까지 한 마디도 받지 못한다.
  it("closes the retired session so the next message can open a new one", async () => {
    const transcriptPath = writeTranscript("sid-slot", []);
    const { factory, openSession, sends } = createFakeSdkFactory([
      { messages: [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }], failAfter: 1 },
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-slot", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("first");
    await drainTurn(registry, "op-slot");

    session.send("second");
    await drainTurn(registry, "op-slot");

    expect(openSession).toHaveBeenCalledTimes(2);
    expect(sends).toEqual(["first", "second"]);
    // 두 번째 턴은 정상으로 닫힌다 — 슬롯이 막혀 있었다면 여기서 chat_turn_failed가 선다.
    expect(events.filter((entry) => entry.event.kind === "error" && entry.event.code === "chat_turn_failed")).toHaveLength(0);
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry — context window", () => {
  const usage = {
    total: 24_948,
    max: 200_000,
    model: "claude-gateway--cursor--auto",
    compactAt: 167_000,
    categories: [
      { name: "System prompt", tokens: 99_014, deferred: false },
      { name: "Memory files", tokens: 20_614, deferred: false },
      { name: "Messages", tokens: 195, deferred: false },
      { name: "Autocompact buffer", tokens: 33_000, deferred: false },
      { name: "Free space", tokens: 47_177, deferred: false },
      { name: "MCP tools (deferred)", tokens: 9_000, deferred: true },
    ],
    memoryFiles: [{ path: "/repo/CLAUDE.md", tokens: 848 }],
    mcpTools: [{ name: "wiki_read", server: "fleet", tokens: 240 }],
  };

  it("recounts the total from the spent categories and sets the reserve aside", async () => {
    // vendor의 total(24,948)은 게이트웨이가 실제로 읽은 토큰이고, 카테고리는 CLI가 센 로컬
    // 배분이라 둘이 어긋난다(실측). 화면은 내역과 총량을 나란히 세우므로 내역이 곧 총량이어야
    // 한다 — 그리고 예약분과 남은 자리는 쓴 것이 아니다.
    const transcriptPath = writeTranscript("sid-ctx-1", []);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }], context: usage },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ctx", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-ctx");
    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event.kind === "context")).toBe(true);
    });

    const context = events.find((entry) => entry.event.kind === "context")?.event;
    expect(context).toMatchObject({
      kind: "context",
      // 99,014 + 20,614 + 195 — deferred·예약·남은 자리는 빠진다.
      total: 119_823,
      max: 200_000,
      reserved: 33_000,
      compactAt: 167_000,
    });
    expect(context && "slices" in context ? context.slices.map((slice) => slice.name) : []).toEqual([
      "System prompt",
      "Memory files",
      "Messages",
    ]);
    await registry.disposeAll();
  });

  /** 게이트웨이 좌표 하나를 실창과 함께 실은 시드. 자식은 여전히 자기 200k 칸으로 답한다. */
  function gatewaySeedFor(transcriptPath: string): AgentChatSessionSeed {
    return {
      ...seedFor(transcriptPath),
      model: "claude-gateway--xai--grok-4.6",
      contextWindow: 500_000,
    };
  }

  it("reads the child's coordinate back onto the model's real window", async () => {
    // 자식은 창이 500k인 모델도 자기 200k 칸으로 잰다. 분모만 바꾸면 점유율이 실제의 1/3로
    // 보이므로 내역·예약·임계선까지 같은 자로 되돌린다.
    const transcriptPath = writeTranscript("sid-ctx-real", []);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }], context: usage },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ctx-real", () => gatewaySeedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-ctx-real");
    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event.kind === "context")).toBe(true);
    });

    const context = events.find((entry) => entry.event.kind === "context")?.event;
    expect(context).toMatchObject({
      kind: "context",
      max: 500_000,
      // 99,014 + 20,614 + 195 을 **각각** 되돌린 합(285,255 + 59,387 + 563). 합을 먼저 되돌리지
      // 않는 이유는 화면이 행과 총량을 나란히 세우기 때문이다 — 행 합이 곧 총량이어야 한다.
      total: 345_205,
      // 자식의 33,000이 아니라 정책이 정하는 실제 여유(Auto = 창 − 16k)다.
      reserved: 16_000,
      compactAt: 484_000,
    });
    // 되돌린 뒤에도 점유는 창을 넘지 않고, 예약분과 함께 창 안에 앉는다.
    const spent = context && "total" in context ? context.total : 0;
    expect(spent + 16_000).toBeLessThanOrEqual(500_000);
    await registry.disposeAll();
  });

  it("leaves a native session's numbers alone", async () => {
    // 네이티브 Claude 모델은 애초에 투영이 없다. 시드에 실창이 없으므로 자식의 좌표가 그대로
    // 나가야 한다 — 되돌릴 것이 없는데 되돌리면 없던 거짓을 만든다.
    const transcriptPath = writeTranscript("sid-ctx-native", []);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }], context: usage },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ctx-native", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-ctx-native");
    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event.kind === "context")).toBe(true);
    });

    expect(events.find((entry) => entry.event.kind === "context")?.event).toMatchObject({
      total: 119_823,
      max: 200_000,
      reserved: 33_000,
      compactAt: 167_000,
    });
    await registry.disposeAll();
  });

  it("asks again once the turn closes, and marks that answer as the authority", async () => {
    // 방금 끝난 턴이 더한 몫의 **내역**은 이 요청만이 안다. 실물은 턴이 닫힌 뒤에도 답한다(실측).
    const transcriptPath = writeTranscript("sid-ctx-end", []);
    const after = { ...usage, categories: [...usage.categories.slice(0, 2), { name: "Messages", tokens: 1_195, deferred: false }, ...usage.categories.slice(3)] };
    const { factory } = createFakeSdkFactory([
      {
        messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }],
        context: usage,
        contextAfter: after,
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ctx-end", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-ctx-end");
    await vi.waitFor(() => {
      expect(events.filter((entry) => entry.event.kind === "context")).toHaveLength(2);
    });

    const contexts = events
      .filter((entry) => entry.event.kind === "context")
      .map((entry) => entry.event as { readonly asOf?: string; readonly total: number });
    expect(contexts[0]).toMatchObject({ asOf: "start", total: 119_823 });
    // 종료 값은 그 턴이 더한 1,000을 포함하고, 스스로를 권위로 표시한다.
    expect(contexts[1]).toMatchObject({ asOf: "end", total: 120_823 });
    await registry.disposeAll();
  });

  it("streams the total from message_delta usage and ignores the other usage shapes", async () => {
    // 쓸 수 있는 신호는 하나뿐이다(실측): message_start와 완성 assistant의 usage는 0으로 오고,
    // result.usage는 그 턴의 모든 모델 호출을 합산한 값이라 창 점유가 아니다.
    const transcriptPath = writeTranscript("sid-ctx-live", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 0, cache_read_input_tokens: 0 } } } },
          { type: "assistant", message: { usage: { input_tokens: 0, cache_read_input_tokens: 0 } } },
          { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 50, cache_read_input_tokens: 14_795 } } },
          // 서브에이전트의 창은 부모의 창이 아니다.
          { type: "stream_event", parent_tool_use_id: "toolu_1", event: { type: "message_delta", usage: { input_tokens: 400_000, cache_read_input_tokens: 0 } } },
          { type: "result", subtype: "success", is_error: false, duration_ms: 4, usage: { input_tokens: 1_029, cache_read_input_tokens: 60_601 } },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ctx-live", () => gatewaySeedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-ctx-live");

    const live = events.filter((entry) => entry.event.kind === "context-live");
    expect(live).toHaveLength(1);
    // 50 + 14,795 = 14,845 을 실창으로 되돌린 값.
    expect(live[0]?.event).toMatchObject({ kind: "context-live", total: 42_768, max: 500_000 });
    await registry.disposeAll();
  });

  it("keeps the live total out of the journal", async () => {
    // 라이브 총량은 모델 호출마다 흐른다. 저널(cap 2000)에 쌓으면 되돌릴 수 없는 이력을 앞에서부터
    // 밀어내고, 재접속은 그 값을 복원할 필요도 없다 — 다음 경계가 측정을 다시 실어 준다.
    const transcriptPath = writeTranscript("sid-ctx-live-journal", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 12_000 } } },
          { type: "result", subtype: "success", is_error: false, duration_ms: 4 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ctx-live-journal", () => gatewaySeedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-ctx-live-journal");
    expect(events.some((entry) => entry.event.kind === "context-live")).toBe(true);

    const replayed: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => replayed.push(entry));
    expect(kinds(replayed)).not.toContain("context-live");
    await registry.disposeAll();
  });

  it("says nothing when the child does not answer", async () => {
    // 자식은 턴이 시작되면 control 채널을 닫는다(실측). 답이 없는 턴에 0짜리 미터를 세우면
    // 화면이 "문맥이 비었다"고 말하게 된다 — 그것은 빈 사실이 아니라 틀린 사실이다.
    const transcriptPath = writeTranscript("sid-ctx-2", []);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-ctx-2", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-ctx-2");

    expect(kinds(events)).not.toContain("context");
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry — journal weight", () => {
  it("keeps only the latest progress snapshot per job in the replayed journal", async () => {
    // 맥박은 스냅숏이다 — 겹겹이 쌓으면 재접속이 이미 지나간 단계 트리를 되재생하고, 상한에
    // 걸린 세션에서는 그 무게가 되돌릴 수 없는 이력을 앞에서부터 밀어낸다.
    const transcriptPath = writeTranscript("sid-pulse-1", []);
    const pulse = (id: string, tokens: number) => ({
      type: "system", subtype: "task_progress", task_id: id,
      usage: { total_tokens: tokens, tool_uses: 0, duration_ms: tokens },
    });
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "w1", description: "one", task_type: "local_workflow" },
          { type: "system", subtype: "task_started", task_id: "w2", description: "two", task_type: "local_workflow" },
          pulse("w1", 1), pulse("w1", 2), pulse("w2", 10), pulse("w1", 3), pulse("w2", 20),
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-pulse-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-pulse-1");

    // 재접속이 받는 것은 저널 전체다.
    const replayed: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => replayed.push(entry));
    const progress = replayed
      .map((entry) => entry.event)
      .filter((event): event is Extract<typeof event, { kind: "job-progress" }> => event.kind === "job-progress");
    expect(progress).toEqual([
      { kind: "job-progress", id: "w1", tokens: 3, tools: 0, durationMs: 3 },
      { kind: "job-progress", id: "w2", tokens: 20, tools: 0, durationMs: 20 },
    ]);
    // 되돌릴 수 없는 이력은 그대로 남는다.
    expect(kinds(replayed).filter((kind) => kind === "job")).toHaveLength(2);
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

  it("keeps an explicitly queued next turn after stopping the current one", async () => {
    const transcriptPath = writeTranscript("sess-stop-queue", []);
    const { factory, liveSession, sends } = createFakeSdkFactory([
      { messages: [] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-2", () => seedFor(transcriptPath));

    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    session.send("second");
    await vi.waitFor(() => { expect(sends).toEqual(["first"]); });

    expect(session.stopTurn()).toBe(true);
    liveSession()?.emit({ type: "result", subtype: "error_during_execution", is_error: true });
    await drainTurn(registry, "op-stop-2");

    expect(sends).toEqual(["first", "second"]);
    const dispatches = seen.map((entry) => entry.event).filter((event) => event.kind === "dispatch");
    expect(dispatches).toHaveLength(2);
    await registry.disposeAll();
  });

  /** 마지막으로 실린 예약 전량. REPLACE 시맨틱이라 최신 하나가 곧 지금의 사정이다. */
  function latestQueue(events: readonly AgentChatJournalEvent[]): readonly { readonly id: string; readonly text: string }[] {
    const queue = events.map((entry) => entry.event).filter((event) => event.kind === "queue");
    return queue.at(-1)?.entries ?? [];
  }

  // 예약은 수가 아니라 좌표를 가진 목록이다 — 취소가 닿을 자리가 있어야 하고, 자기 차례가 오면
  // 그 자리는 비워져야 한다(시작한 지시는 취소가 아니라 중지의 몫이다).
  it("carries each queued instruction with a coordinate and drops it once the turn starts", async () => {
    const transcriptPath = writeTranscript("sess-queue", []);
    const { factory, liveSession, sends } = createFakeSdkFactory([
      { messages: [] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-queue", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    session.send("second");
    await vi.waitFor(() => { expect(sends).toEqual(["first"]); });
    // 도는 지시는 목록에 없다 — 남은 것은 아직 서지 않은 하나뿐이다.
    expect(latestQueue(seen).map((entry) => entry.text)).toEqual(["second"]);

    liveSession()?.emit({ type: "result", subtype: "success", is_error: false, duration_ms: 4 });
    await drainTurn(registry, "op-queue");
    expect(sends).toEqual(["first", "second"]);
    expect(latestQueue(seen)).toEqual([]);
    await registry.disposeAll();
  });

  // 첨부가 붙은 지시의 프롬프트에는 호스트 절대 경로가 실린다. 자식은 그것을 받아야 하지만
  // 브라우저는 받으면 안 된다 — 예약 칩이 임시 파일 경로를 실어 나르는 자리가 여기였다.
  it("keeps the dispatch prompt's host paths out of the queue it sends to the browser", async () => {
    const transcriptPath = writeTranscript("sess-queue-preview", []);
    const { factory, sends, liveSession } = createFakeSdkFactory([
      { messages: [] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-queue-preview", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    await vi.waitFor(() => { expect(sends).toEqual(["first"]); });
    const prompt = "look at this\n\nRead the attached image file: /tmp/launch-attachments/ab12/shot.png";
    session.send(prompt, "look at this");

    const queued = latestQueue(seen);
    expect(queued.map((entry) => entry.text)).toEqual(["look at this"]);
    expect(JSON.stringify(queued)).not.toContain("/tmp/launch-attachments");
    // 자식에게는 여전히 전문이 간다 — 경로를 지운 것이 아니라 화면에 내보내지 않을 뿐이다.
    liveSession()?.emit({ type: "result", subtype: "success", is_error: false, duration_ms: 4 });
    await drainTurn(registry, "op-queue-preview");
    expect(sends).toEqual(["first", prompt]);
    await registry.disposeAll();
  });

  it("cancels a queued instruction so it never reaches the child", async () => {
    const transcriptPath = writeTranscript("sess-queue-cancel", []);
    const { factory, liveSession, sends } = createFakeSdkFactory([
      { messages: [] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-queue-cancel", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    session.send("cancel me");
    await vi.waitFor(() => { expect(sends).toEqual(["first"]); });

    const queued = latestQueue(seen)[0];
    expect(session.cancelQueued(queued?.id ?? "")).toBe(true);
    expect(latestQueue(seen)).toEqual([]);

    // 앞 턴이 닫혀 자기 차례가 와도 서지 않는다 — 자식은 그 문면을 본 적이 없다.
    liveSession()?.emit({ type: "result", subtype: "success", is_error: false, duration_ms: 4 });
    await drainTurn(registry, "op-queue-cancel");
    expect(sends).toEqual(["first"]);
    const dispatches = seen.map((entry) => entry.event).filter((event) => event.kind === "dispatch");
    expect(dispatches.map((event) => event.text)).toEqual(["first"]);
    await registry.disposeAll();
  });

  // 거둘 것이 없으면 거절한다. ok로 답하면 화면이 칩을 지우고, 그 지시는 잠시 뒤 태연히 시작한다.
  it("refuses to cancel a coordinate that is unknown or already running", async () => {
    const transcriptPath = writeTranscript("sess-queue-race", []);
    const { factory, sends } = createFakeSdkFactory([
      { messages: [] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-queue-race", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    await vi.waitFor(() => { expect(sends).toEqual(["first"]); });
    // 지어낸 좌표도, 이미 시작해 목록에서 내려간 첫 지시의 좌표도 이 문을 통과하지 못한다.
    expect(session.cancelQueued("q404")).toBe(false);
    expect(session.cancelQueued("q1")).toBe(false);
    await registry.disposeAll();
  });

  // 예약은 저널에 없다(라이브 전용). 재접속한 화면이 자기 힘으로 되찾을 길이 없으므로 구독이
  // 재생 경계 **뒤에** 스냅숏 하나를 실어 준다 — 앞에 두면 replay-start가 그 자리를 곧바로 비운다.
  it("hands a reconnecting subscriber the queue after the replay boundary", async () => {
    const transcriptPath = writeTranscript("sess-queue-reconnect", []);
    const { factory, sends } = createFakeSdkFactory([
      { messages: [] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-queue-reconnect", () => seedFor(transcriptPath));
    session.send("first");
    session.send("still waiting");
    await vi.waitFor(() => { expect(sends).toEqual(["first"]); });

    const reconnected: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => reconnected.push(entry));
    // 재생 경계 뒤, 그리고 snapshot-end 앞이다 — 예약은 이번 접속이 발견한 사정이지 새 도착이 아니다.
    const order = kinds(reconnected);
    expect(order.at(-1)).toBe("snapshot-end");
    expect(order.indexOf("replay-end")).toBeLessThan(order.lastIndexOf("queue"));
    expect(order.lastIndexOf("queue")).toBeLessThan(order.lastIndexOf("snapshot-end"));
    expect(latestQueue(reconnected).map((entry) => entry.text)).toEqual(["still waiting"]);

    // 리듀서도 같은 자리에 접는다 — 재생이 비운 뒤 스냅숏이 채운다.
    let state = initialAgentChatLogState;
    for (const entry of reconnected) state = reduceAgentChatLog(state, entry.event);
    expect(state.queue.map((entry) => entry.text)).toEqual(["still waiting"]);
    await registry.disposeAll();
  });

  // 자식은 중단을 받아도 그 턴의 result를 반드시 낸다(실측: interrupt 뒤 2ms). 중지 직후의 새
  // 메시지가 그 결말에 실려 나가면, 답하지도 않은 프롬프트가 끝난 것으로 그려진다.
  it("keeps a new send behind the interrupted turn's result", async () => {
    const transcriptPath = writeTranscript("sess-stop-settle", []);
    const { factory, liveSession, sends } = createFakeSdkFactory([
      { messages: [] },
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-settle", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    await vi.waitFor(() => { expect(sends).toEqual(["first"]); });
    expect(session.stopTurn()).toBe(true);

    session.send("second");
    // 중단된 턴의 result가 아직 오지 않았다 — 그동안 두 번째 프롬프트는 자식에 닿지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sends).toEqual(["first"]);

    // 자식이 뒤늦게 그 턴의 결말을 낸다. 그것은 이미 닫은 턴의 것이므로 원장에 서지 않는다.
    liveSession()?.emit({ type: "result", subtype: "error_during_execution", is_error: true });
    await drainTurn(registry, "op-stop-settle");

    expect(sends).toEqual(["first", "second"]);
    const ends = seen.map((entry) => entry.event).filter((event) => event.kind === "turn-end");
    // 중지 하나 + 두 번째 턴의 정상 결말 하나. 중단 result가 세 번째 결말로 서지 않는다.
    expect(ends).toEqual([
      { kind: "turn-end", ok: false, stopped: true },
      { kind: "turn-end", ok: true, durationMs: 4 },
    ]);
    await registry.disposeAll();
  });

  // 세션을 여는 동안(자식 spawn·플러그인·MCP 발급은 몇 초가 걸린다) 중지하면 그 턴은 자식이
  // 존재조차 모른 채 닫힌다. 그때 결말을 기다리기 시작하면 오지 않을 것을 기다리며 세션이 막힌다.
  it("does not wait for a settlement when the stopped turn never reached the child", async () => {
    const transcriptPath = writeTranscript("sess-stop-early", []);
    const configDir = tempDir("chat-sdk-");
    let releaseOpen: () => void = () => {};
    const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const sends: string[] = [];
    let opened = 0;
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      // 첫 세션은 문이 열릴 때까지 준비 중이다 — 사용자가 그 사이에 중지한다.
      openSession: async () => {
        if (opened++ === 0) await opening;
        return fakeSession([
          { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 4 }] },
        ], { onSend: (text) => sends.push(text) });
      },
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-early", () => seedFor(transcriptPath));
    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    await vi.waitFor(() => { expect(kinds(seen)).toContain("turn-start"); });
    expect(session.stopTurn()).toBe(true);
    releaseOpen();
    await drainTurn(registry, "op-stop-early");
    // 자식에 닿은 적이 없으므로 그 프롬프트는 전달되지 않았다.
    expect(sends).toEqual([]);

    // 다음 메시지는 오지 않을 결말을 기다리지 않는다.
    session.send("second");
    await drainTurn(registry, "op-stop-early");
    expect(sends).toEqual(["second"]);
    expect(seen.map((entry) => entry.event)).toContainEqual({ kind: "turn-end", ok: true, durationMs: 4 });
    await registry.disposeAll();
  });

  it("refuses when there is no turn to stop", async () => {
    // 끊을 것이 없는데 성공을 돌려주면 화면이 멈춤을 그리고 아무 일도 일어나지 않는다.
    const transcriptPath = writeTranscript("sess-stop-idle", []);
    const { factory } = createHangingSdkFactory();
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-3", () => seedFor(transcriptPath));
    expect(session.stopTurn()).toBe(false);
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
describe("AgentChatRegistry — job detail", () => {
  it("reads a shell tail from the path the notification announced, not a reconstructed one", async () => {
    const transcriptPath = writeTranscript("sess-detail", []);
    // 알림이 가리키는 파일을 config dir 바깥에 둔다 — 재구성한 경로로는 절대 닿을 수 없는 자리다.
    const outputRoot = tempDir("chat-task-out-");
    const outputFile = path.join(outputRoot, "b7chatty.output");
    writeFileSync(outputFile, "tick 1\ntick 2\ntick 3\n");

    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "b7chatty", description: "loop", task_type: "local_bash" },
          { type: "system", subtype: "task_notification", task_id: "b7chatty", status: "completed", output_file: outputFile, summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-detail-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-detail-1");

    const detail = await session.readJobDetail("b7chatty");
    expect(detail).toEqual({ kind: "shell", tail: "tick 1\ntick 2\ntick 3", truncated: false });

    // 저널 어디에도 그 절대 경로가 실리지 않는다 — 브라우저로 나가는 것은 저널이다.
    const journal: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => journal.push(entry));
    expect(JSON.stringify(journal)).not.toContain(outputRoot);
    await registry.disposeAll();
  });

  it("refuses a job coordinate the session never issued", async () => {
    // 브라우저가 건네는 유일한 값이다. SDK가 발급한 적 없는 좌표는 파일 시스템에 닿기 전에 막힌다.
    const transcriptPath = writeTranscript("sess-detail-guard", []);
    const { factory } = createFakeSdkFactory([{ messages: [] }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-detail-2", () => seedFor(transcriptPath));
    expect(await session.readJobDetail("../../etc/passwd")).toBeNull();
    expect(await session.readJobDetail("never-issued")).toBeNull();
    await registry.disposeAll();
  });
});

/**
 * 큰 출력 파일.
 *
 * 돌려주는 값이 작아도 파일 전체를 문자열로 올리면 그 순간의 메모리와 이벤트 루프는 파일
 * 크기만큼을 진다 — 실측에서 백그라운드 셸 출력은 이미 438KB까지 자랐고, 빌드를 백그라운드로
 * 돌리면 수십 MB가 정상 범위다.
 */
describe("AgentChatRegistry — large shell output", () => {
  it("reads only the end of the file", async () => {
    const transcriptPath = writeTranscript("sess-big", []);
    const outputRoot = tempDir("chat-task-big-");
    const outputFile = path.join(outputRoot, "b9huge.output");
    // 읽기 창(256KB)보다 확실히 큰 파일. 창 밖의 표식은 결과 어디에도 나타나지 않아야 한다 —
    // 나타난다면 파일 전체가 메모리에 올라왔다는 뜻이다.
    const filler = Array.from({ length: 40_000 }, (_, i) => `noise ${i} ${"y".repeat(40)}`).join("\n");
    writeFileSync(outputFile, `HEAD-MARKER\n${filler}\nTAIL-MARKER\n`);

    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "b9huge", description: "big", task_type: "local_bash" },
          { type: "system", subtype: "task_notification", task_id: "b9huge", status: "completed", output_file: outputFile, summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-big-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-big-1");

    // 내용만으로는 전체 읽기와 구별되지 않는다 — 200줄 컷이 같은 결과를 내기 때문이다.
    // 그래서 "파일 전체를 문자열로 올리지 않았다"를 직접 못 박는다.
    const readFile = vi.spyOn(nodeFs, "readFile");
    const open = vi.spyOn(nodeFs, "open");
    try {
      const detail = await session.readJobDetail("b9huge");
      expect(detail?.kind).toBe("shell");
      const tail = detail?.kind === "shell" ? detail.tail : "";
      expect(tail).toContain("TAIL-MARKER");
      expect(tail).not.toContain("HEAD-MARKER");
      expect(detail?.truncated).toBe(true);
      expect(open.mock.calls.some(([target]) => target === outputFile)).toBe(true);
      expect(readFile.mock.calls.some(([target]) => target === outputFile)).toBe(false);
    } finally {
      readFile.mockRestore();
      open.mockRestore();
    }
    await registry.disposeAll();
  });
});

/**
 * 창보다 큰 줄 하나.
 *
 * 앞선 경계-읽기 수정이 만든 결함이다: 줄 경계에 맞추려고 첫 개행까지를 버리는데, 마지막 한
 * 줄이 창보다 크면 개행이 창의 맨 끝에만 있거나 아예 없어서 버퍼 전체가 사라진다. 화면은 그때
 * 빈 꼬리를 보인다 — 잘린 줄 하나가 빈 화면보다 정직하다.
 */
describe("AgentChatRegistry — one line larger than the read window", () => {
  it("keeps the newest bytes instead of returning an empty tail", async () => {
    const transcriptPath = writeTranscript("sess-longline", []);
    const outputRoot = tempDir("chat-task-line-");
    const outputFile = path.join(outputRoot, "b1line.output");
    // 한 줄이 512KB — 창(256KB)보다 크고, 줄 끝에만 개행이 있다.
    writeFileSync(outputFile, `${"j".repeat(512 * 1024)}NEWEST-END\n`);

    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "b1line", description: "json", task_type: "local_bash" },
          { type: "system", subtype: "task_notification", task_id: "b1line", status: "completed", output_file: outputFile, summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-line-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-line-1");

    const detail = await session.readJobDetail("b1line");
    const tail = detail?.kind === "shell" ? detail.tail : null;
    expect(tail).not.toBe("");
    expect(tail).toContain("NEWEST-END");
    expect(detail?.truncated).toBe(true);
    await registry.disposeAll();
  });

  it("bounds the subagent transcript read the same way", async () => {
    const transcriptPath = writeTranscript("sess-bigtrail", []);
    const { factory, configDir } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "init", session_id: "sess-bigtrail" },
          { type: "system", subtype: "task_started", task_id: "atrail1", description: "recon", task_type: "local_agent" },
          { type: "system", subtype: "task_notification", task_id: "atrail1", status: "completed", summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-trail-1", () => seedFor(transcriptPath));

    // 창(4MB)보다 큰 전사록. 앞쪽 표식은 결과에 나타나면 안 된다.
    // 부산물은 트랜스크립트와 같은 홈에 앉는다 — 공유 홈에서는 SDK의 config dir이 곧 그 홈이다.
    const subagentDir = path.join(homeOf(transcriptPath), "projects", "-tmp-workspace", "sess-bigtrail", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const line = (name: string) => JSON.stringify({
      isSidechain: true,
      type: "assistant",
      message: { content: [{ type: "tool_use", id: name, name, input: { command: "x".repeat(600) } }] },
    });
    const filler = Array.from({ length: 7_000 }, (_, i) => line(`Filler${i}`)).join("\n");
    writeFileSync(path.join(subagentDir, "agent-atrail1.jsonl"), `${line("HeadMarker")}\n${filler}\n${line("TailMarker")}\n`);

    session.send("go");
    await drainTurn(registry, "op-trail-1");

    const readFile = vi.spyOn(nodeFs, "readFile");
    try {
      const detail = await session.readJobDetail("atrail1");
      expect(detail?.kind).toBe("agent");
      const names = detail?.kind === "agent" ? detail.steps.map((step) => step.name) : [];
      expect(names).toContain("TailMarker");
      expect(names).not.toContain("HeadMarker");
      expect(detail?.truncated).toBe(true);
      expect(readFile.mock.calls.some(([target]) => String(target).includes("agent-atrail1"))).toBe(false);
    } finally {
      readFile.mockRestore();
    }
    await registry.disposeAll();
  });
});
