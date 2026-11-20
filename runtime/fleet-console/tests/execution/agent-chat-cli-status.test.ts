import { describe, expect, it, vi } from "vitest";

import { AgentChatRegistry, type AgentChatSessionSeed } from "../../features/execution/host/agent/chat-session.js";
import { probeClaudeAuth } from "../../features/execution/host/agent/claude-auth-status.js";
import type { AgentChatStreamEvent } from "../../features/execution/host/agent/chat-events.js";
import { agentChatCliFailure, initialAgentChatLogState, reduceAgentChatLog } from "../../features/execution/client/agent/chat/chat-events.js";
import { composeGroupTimeline, EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal } from "../../features/execution/client/agent/chat/group-timeline.js";

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

    unsub();
    await registry.disposeAll();
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

  it("probes the shared CLAUDE_CONFIG_DIR without creating or deleting a temp dir when configDir is passed", async () => {
    const createConfigDir = vi.fn();
    const removeConfigDir = vi.fn();
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const result = await probeClaudeAuth("/fake/claude", {
      configDir: "/shared/claude-home",
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret" },
      createConfigDir,
      removeConfigDir,
      run: async (_bin, _args, env) => {
        seenEnv = env;
        return { stdout: JSON.stringify({ loggedIn: true }) };
      },
    });
    expect(result).toBe("ready");
    expect(createConfigDir).not.toHaveBeenCalled();
    expect(removeConfigDir).not.toHaveBeenCalled();
    expect(seenEnv?.CLAUDE_CONFIG_DIR).toBe("/shared/claude-home");
    expect(seenEnv?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(seenEnv?.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
