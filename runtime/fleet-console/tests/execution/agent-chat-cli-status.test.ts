import { describe, expect, it, vi } from "vitest";

import { AgentChatRegistry, type AgentChatSessionSeed } from "../../features/execution/host/agent/chat-session.js";
import { chatReplayFromTranscriptLine } from "../../features/execution/host/agent/chat-events.js";
import { probeClaudeAuth } from "../../features/execution/host/agent/claude-auth-status.js";
import type { AgentChatStreamEvent } from "../../features/execution/host/agent/chat-events.js";
import { agentChatCliFailure, initialAgentChatLogState, reduceAgentChatLog } from "../../features/execution/client/agent/chat/chat-events.js";
import { composeGroupTimeline, EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal } from "../../features/execution/client/agent/chat/group-timeline.js";
import { buildCommanderFlow } from "../../features/execution/client/agent/chat/group/commander-flow-model.js";

function baseSeed(overrides: Partial<AgentChatSessionSeed> = {}): AgentChatSessionSeed {
  return {
    baseUrl: "http://127.0.0.1:9/gateway",
    cwd: "/tmp/workspace",
    claudeConfigDir: "/tmp/claude-home",
    model: "claude-opus-4-6",
    origin: { kind: "fresh" },
    reportActivity: () => true,
    canReportActivity: () => true,
    reportAwaiting: () => {},
    reportBackgroundPending: () => {},
    onProviderSessionUpdate: () => undefined,
    resolveClaudeSession: async () => ({
      sessionId: "sid-auth",
      coordinate: { kind: "new", sessionId: "sid-auth" },
      claudeCodeSystemPrompt: "off",
      sdk: { options: {} },
      pluginEnv: {},
    }) as never,
    ...overrides,
  };
}

describe("commander chat CLI failure classification", () => {
  it("keeps chat_cli_unavailable without overwriting it with chat_turn_failed", async () => {
    const events: AgentChatStreamEvent[] = [];
    const registry = new AgentChatRegistry(vi.fn() as never);
    const session = await registry.ensure("obj-missing", () => baseSeed({
      resolveExecutablePath: async () => { throw new Error("chat_cli_unavailable"); },
    }));
    const unsub = session.subscribe((entry) => { events.push(entry.event); });

    session.send("hello");
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "turn-end" && event.ok === false)).toBe(true);
    });

    const errors = events.filter((event): event is Extract<AgentChatStreamEvent, { kind: "error" }> => event.kind === "error");
    expect(errors.map((event) => event.code)).toEqual(["chat_cli_unavailable"]);
    unsub();
    await registry.disposeAll();
  });

  it("emits chat_cli_signed_out when a turn ends with authentication_failed", async () => {
    const events: AgentChatStreamEvent[] = [];
    const queue: Record<string, unknown>[] = [];
    let waiting: ((value: IteratorResult<Record<string, unknown>>) => void) | null = null;
    let closed = false;
    const pushMessage = (msg: Record<string, unknown>) => {
      if (waiting) { const resolve = waiting; waiting = null; resolve({ value: msg, done: false }); }
      else queue.push(msg);
    };
    const endStream = () => {
      closed = true;
      if (waiting) { const resolve = waiting; waiting = null; resolve({ value: undefined, done: true }); }
    };
    const fakeSession = {
      send: () => {
        pushMessage({
          type: "assistant",
          session_id: "sid-auth",
          error: "authentication_failed",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "Not logged in · Please run /login" }],
          },
        });
        pushMessage({
          type: "result",
          subtype: "success",
          is_error: true,
          session_id: "sid-auth",
          result: "Not logged in · Please run /login",
          errors: ["Not logged in · Please run /login"],
          num_turns: 1,
          duration_ms: 5,
        });
      },
      interrupt: async () => undefined,
      supportedCommands: async () => null,
      supportedAgents: async () => null,
      supportedSkills: async () => null,
      reloadSkills: async () => null,
      setModel: async () => undefined,
      applySessionSettings: async () => undefined,
      getContextUsage: async () => null,
      close: () => { endStream(); },
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<Record<string, unknown>>>((resolve) => { waiting = resolve; });
        },
      }),
    };
    const registry = new AgentChatRegistry((async (options: { readonly models: readonly string[] }) => ({
      configDir: "/tmp/claude-home",
      models: options.models,
      startTurn: async () => { throw new Error("unexpected"); },
      openSession: async () => fakeSession,
      dispose: async () => undefined,
    })) as never);
    const session = await registry.ensure("obj-signedout", () => baseSeed({
      resolveExecutablePath: async () => "/fake/claude",
    }));
    const unsub = session.subscribe((entry) => { events.push(entry.event); });

    session.send("hello signed out");
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "turn-end")).toBe(true);
    });
    expect(events.filter((event) => event.kind === "error" || event.kind === "turn-end")).toEqual([
      expect.objectContaining({ kind: "turn-end", ok: false }),
      { kind: "error", code: "chat_cli_signed_out" },
    ]);
    // 합성 원문 "Not logged in · Please run /login"은 지휘관 말풍선(text)으로 방출되지 않는다.
    expect(events.filter((event) => event.kind === "text")).toEqual([]);

    unsub();
    await registry.disposeAll();
  });

  it("replays synthetic authentication_failed assistant lines as chat_cli_signed_out instead of raw text", () => {
    const line = JSON.stringify({
      type: "assistant",
      error: "authentication_failed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
      },
    });
    expect(chatReplayFromTranscriptLine(line).events).toEqual([{ kind: "error", code: "chat_cli_signed_out" }]);
  });
});

describe("commander chat client CLI failure state", () => {
  it("maps chat_cli_unavailable and chat_cli_signed_out and clears them on dispatch or ok turn-end", () => {
    let state = reduceAgentChatLog(initialAgentChatLogState, { kind: "dispatch", text: "hi" });
    state = reduceAgentChatLog(state, { kind: "error", code: "chat_cli_unavailable" });
    expect(agentChatCliFailure(state.errorCode)).toBe("missing");

    state = reduceAgentChatLog(state, { kind: "dispatch", text: "retry" });
    expect(agentChatCliFailure(state.errorCode)).toBeNull();

    state = reduceAgentChatLog(state, { kind: "error", code: "chat_cli_signed_out" });
    expect(agentChatCliFailure(state.errorCode)).toBe("signedout");

    state = reduceAgentChatLog(state, { kind: "turn-end", ok: true });
    expect(agentChatCliFailure(state.errorCode)).toBeNull();
  });

  it("projects cliFailure and cliFailurePrompt into GroupTimelineSnapshot", () => {
    const id = "obj-root";
    let journal = reduceConversationJournal(EMPTY_CONVERSATION_JOURNAL, { seq: 1, at: 1000, event: { kind: "dispatch", text: "please check" } }, id);
    journal = reduceConversationJournal(journal, { seq: 2, at: 1001, event: { kind: "error", code: "chat_cli_signed_out" } }, id);
    const snap = composeGroupTimeline({
      rootObjectiveId: id,
      participants: [{ speaker: { kind: "commander", name: "Commander", objectiveId: id }, activity: "idle" }],
      journals: new Map([[id, journal]]),
    });
    expect(snap.cliFailure).toBe("signedout");
    expect(snap.cliFailurePrompt).toBe("please check");

    journal = reduceConversationJournal(journal, { seq: 3, at: 2000, event: { kind: "dispatch", text: "please check" } }, id);
    journal = reduceConversationJournal(journal, { seq: 4, at: 2005, event: { kind: "turn-end", ok: true } }, id);
    const recovered = composeGroupTimeline({
      rootObjectiveId: id,
      participants: [{ speaker: { kind: "commander", name: "Commander", objectiveId: id }, activity: "idle" }],
      journals: new Map([[id, journal]]),
    });
    expect(recovered.cliFailure).toBeUndefined();
    expect(recovered.cliFailurePrompt).toBeUndefined();
  });

  it("clears cliFailurePrompt when a non-human turn fails after an earlier human turn", () => {
    const id = "obj-root";
    let journal = reduceConversationJournal(EMPTY_CONVERSATION_JOURNAL, { seq: 1, at: 1000, event: { kind: "dispatch", text: "old human instruction" } }, id);
    journal = reduceConversationJournal(journal, { seq: 2, at: 1500, event: { kind: "turn-end", ok: true } }, id);
    journal = reduceConversationJournal(journal, {
      seq: 3,
      at: 2000,
      event: { kind: "dispatch", text: "automated plugin wake", by: { kind: "plugin", pluginId: "objectives" } },
    }, id);
    journal = reduceConversationJournal(journal, { seq: 4, at: 2005, event: { kind: "error", code: "chat_cli_signed_out" } }, id);
    const snap = composeGroupTimeline({
      rootObjectiveId: id,
      participants: [{ speaker: { kind: "commander", name: "Commander", objectiveId: id }, activity: "idle" }],
      journals: new Map([[id, journal]]),
    });
    expect(snap.cliFailure).toBe("signedout");
    expect(snap.cliFailurePrompt).toBeUndefined();
  });

  // 지휘관 채팅 자식(공유 홈)은 두 변수를 상속 그대로 둔다. 판정이 기본 홈 경로라도 명시로 세우면 macOS keychain 항목이
  // 갈려 로그인된 사람을 미로그인으로 본다 — 상속이 없으면 없는 대로, 있으면(Linux/WSL 사용자 지정 홈) 있는 그대로 둔다.
  it("probes the inherited shared home like the Commander chat child, without a temp dir or config-dir overrides", async () => {
    const createConfigDir = vi.fn();
    const removeConfigDir = vi.fn();
    const seen: NodeJS.ProcessEnv[] = [];
    const probe = (env: NodeJS.ProcessEnv) => probeClaudeAuth("/fake/claude", {
      home: "shared",
      env,
      createConfigDir,
      removeConfigDir,
      run: async (_bin, _args, childEnv) => {
        seen.push(childEnv);
        return { stdout: JSON.stringify({ loggedIn: true }) };
      },
    });
    expect(await probe({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret" })).toBe("ready");
    expect(await probe({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/u/.claude-work" })).toBe("ready");
    expect(createConfigDir).not.toHaveBeenCalled();
    expect(removeConfigDir).not.toHaveBeenCalled();
    expect("CLAUDE_CONFIG_DIR" in seen[0]!).toBe(false);
    expect("CLAUDE_SECURESTORAGE_CONFIG_DIR" in seen[0]!).toBe(false);
    expect(seen[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen[1]?.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude-work");
    expect("CLAUDE_SECURESTORAGE_CONFIG_DIR" in seen[1]!).toBe(false);
  });

  it("surfaces non-CLI session errors, delivery refusals, and failure plugin notices into commander flow", () => {
    const rootId = "obj-root";
    const memberId = "obj-builder";
    let rootJournal = reduceConversationJournal(EMPTY_CONVERSATION_JOURNAL, {
      seq: 1,
      at: 1000,
      event: { kind: "dispatch", text: "Build bundle and verify" },
    }, rootId);
    rootJournal = reduceConversationJournal(rootJournal, {
      seq: 2,
      at: 1100,
      event: {
        kind: "tool",
        id: "call-refused",
        name: "mcp__fleet-commander__member_message",
        detail: "",
        toolDetail: { sections: [{ kind: "message", text: "→ verifier\nPlease verify" }] },
      },
    }, rootId);
    rootJournal = reduceConversationJournal(rootJournal, {
      seq: 3,
      at: 1150,
      event: {
        kind: "tool-result",
        id: "call-refused",
        ok: false,
        summary: "delivery_refused: unknown member verifier",
      },
    }, rootId);
    rootJournal = reduceConversationJournal(rootJournal, {
      seq: 4,
      at: 1300,
      event: {
        kind: "dispatch",
        text: 'The last turn of member "builder" (obj-builder) in objective obj-root ended in failure.\nReason: rate_limit_exceeded\n<error-data>\n429 too many requests\n</error-data>',
        by: { kind: "plugin", pluginId: "objectives" },
      },
    }, rootId);

    let memberJournal = reduceConversationJournal(EMPTY_CONVERSATION_JOURNAL, {
      seq: 1,
      at: 1200,
      event: { kind: "turn-start" },
    }, memberId);
    memberJournal = reduceConversationJournal(memberJournal, {
      seq: 2,
      at: 1250,
      event: { kind: "turn-end", ok: false, durationMs: 4200 },
    }, memberId);
    memberJournal = reduceConversationJournal(memberJournal, {
      seq: 3,
      at: 1251,
      event: { kind: "error", code: "chat_turn_failed" },
    }, memberId);
    // User-initiated stop must not fabricate a session-error entry.
    memberJournal = reduceConversationJournal(memberJournal, {
      seq: 4,
      at: 1400,
      event: { kind: "turn-start" },
    }, memberId);
    memberJournal = reduceConversationJournal(memberJournal, {
      seq: 5,
      at: 1450,
      event: { kind: "turn-end", ok: false, stopped: true },
    }, memberId);

    const snap = composeGroupTimeline({
      rootObjectiveId: rootId,
      participants: [
        { speaker: { kind: "commander", name: "Commander", objectiveId: rootId }, activity: "idle" },
        { speaker: { kind: "member", name: "builder", objectiveId: memberId }, activity: "idle" },
      ],
      journals: new Map([
        [rootId, rootJournal],
        [memberId, memberJournal],
      ]),
    });

    const sessionErrors = snap.entries.filter((entry) => entry.kind === "session-error");
    expect(sessionErrors).toHaveLength(1);
    expect(sessionErrors[0]).toMatchObject({ kind: "session-error", code: "chat_turn_failed", objectiveId: memberId });

    const flow = buildCommanderFlow(snap, { language: "en" });
    expect(flow.loops).toHaveLength(1);
    const loop = flow.loops[0]!;
    expect(loop.status).toBe("error");
    expect(loop.hasErrors).toBe(true);
    expect(loop.errors.map((err) => err.code)).toEqual(
      expect.arrayContaining(["delivery_failed", "chat_turn_failed", "member_turn_failed"]),
    );
    expect(loop.edges.some((edge) => edge.status === "error")).toBe(true);
    expect(loop.nodes.some((node) => node.status === "error")).toBe(true);
  });
});
