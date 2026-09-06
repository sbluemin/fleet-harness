import { mkdirSync, mkdtempSync, promises as nodeFs, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeSessionHandle } from "@dotobokuri/fleet-admiral";

import { AgentChatRegistry, type AgentChatSessionSeed } from "../server/agent-api/chat-session.js";
import { initialAgentChatLogState, reduceAgentChatLog } from "../client/agent/chat/chat-events.js";
import type { AgentChatJournalEvent, AgentChatStreamEvent } from "../server/agent-api/chat-events.js";

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
  let commandAttempts = 0;
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
