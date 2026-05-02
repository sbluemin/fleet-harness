import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const client = {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(async () => ({
      protocol: "acp",
      session: { sessionId: "acp-session-1" },
    })),
    sendMessage: vi.fn(() => new Promise<void>(() => {})),
    cancelPrompt: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    removeAllListeners: vi.fn(),
    getConnectionInfo: vi.fn(() => ({ state: "ready", sessionId: "acp-session-1" })),
  };

  return {
    client,
    providers: {
      claude: {
        name: "Anthropic Claude Code",
        defaultModel: "opus",
        models: [{ modelId: "opus", name: "Claude Opus" }],
        reasoningEffort: { supported: false },
      },
      "claude-zai": {
        name: "Claude ZAI",
        defaultModel: "zai-coding-plan/glm-5.1",
        models: [{ modelId: "zai-coding-plan/glm-5.1", name: "GLM-5.1" }],
        reasoningEffort: { supported: false },
      },
      "claude-kimi": {
        name: "Claude Kimi",
        defaultModel: "kimi-for-coding/k2p6",
        models: [{ modelId: "kimi-for-coding/k2p6", name: "Kimi K2P6" }],
        reasoningEffort: { supported: false },
      },
      codex: {
        name: "OpenAI Codex CLI",
        defaultModel: "gpt-5.4",
        models: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
        reasoningEffort: {
          supported: true,
          levels: ["none", "low", "medium", "high", "xhigh"],
          default: "high",
        },
      },
      gemini: {
        name: "Google Gemini CLI",
        defaultModel: "gemini-2.5-flash",
        models: [{ modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }],
        reasoningEffort: { supported: false },
      },
      "opencode-go": {
        name: "OpenCode Go",
        defaultModel: "opencode-go/glm-5.1",
        models: [{ modelId: "opencode-go/glm-5.1", name: "GLM-5.1" }],
        reasoningEffort: { supported: false },
      },
    },
    buildArgs: [] as unknown[],
    lastMapper: null as any,
    routerCalls: [] as Array<[string, unknown]>,
    clearPendingCalls: [] as string[],
    sessionStoreState: {} as Record<string, string | undefined>,
    persistedSessionMaps: {} as Record<string, Record<string, string | undefined> | undefined>,
    boundPiSessionId: null as string | null,
  };
});

vi.mock("@mariozechner/pi-ai", () => ({
  createAssistantMessageEventStream: () => ({
    push: vi.fn(),
    end: vi.fn(),
  }),
}));

vi.mock("@sbluemin/unified-agent", () => ({
  UnifiedAgent: {
    build: vi.fn(async (opts: unknown) => {
      mockState.buildArgs.push(opts);
      return mockState.client;
    }),
  },
  buildProviderClient: vi.fn(async (opts: unknown) => {
    mockState.buildArgs.push(opts);
    return mockState.client;
  }),
  getModelsRegistry: () => ({ providers: mockState.providers }),
  getProviderModels: vi.fn((cli: keyof typeof mockState.providers) => mockState.providers[cli]),
  CLI_BACKENDS: {
    claude: {
      id: "claude",
      name: "Anthropic Claude Code",
      cliCommand: "claude",
      protocol: "acp",
      authRequired: true,
      supportsSessionClose: true,
      supportsSessionLoad: true,
      requiresModelAtSpawn: false,
      usesNpxBridge: true,
      defaultMaxTokens: 16_384,
      colorRgb: [255, 149, 0],
      bgColorRgb: [40, 25, 8],
    },
    codex: {
      id: "codex",
      name: "OpenAI Codex CLI",
      cliCommand: "codex",
      protocol: "codex-app-server",
      authRequired: true,
      supportsSessionClose: true,
      supportsSessionLoad: true,
      requiresModelAtSpawn: false,
      usesNpxBridge: false,
      defaultMaxTokens: 100_000,
      colorRgb: [169, 169, 169],
      bgColorRgb: [35, 35, 35],
    },
    gemini: {
      id: "gemini",
      name: "Google Gemini CLI",
      cliCommand: "gemini",
      protocol: "acp",
      authRequired: true,
      supportsSessionClose: false,
      supportsSessionLoad: false,
      requiresModelAtSpawn: true,
      usesNpxBridge: false,
      defaultMaxTokens: 65_536,
      colorRgb: [66, 133, 244],
      bgColorRgb: [15, 22, 42],
    },
  },
}));

vi.mock("../../src/agent/provider-internal/session-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/provider-internal/session-runtime.js")>();
  return {
    ...actual,
    onHostSessionChange: vi.fn((piSessionId: string) => {
      mockState.boundPiSessionId = piSessionId;
      mockState.sessionStoreState = { ...(mockState.persistedSessionMaps[piSessionId] ?? {}) };
    }),
    getSessionStore: vi.fn(() => ({
      restore: vi.fn(),
      get: vi.fn((key: string) => mockState.sessionStoreState[key]),
      set: vi.fn((key: string, value: string) => {
        mockState.sessionStoreState[key] = value;
        if (mockState.boundPiSessionId) {
          mockState.persistedSessionMaps[mockState.boundPiSessionId] = {
            ...(mockState.persistedSessionMaps[mockState.boundPiSessionId] ?? {}),
            [key]: value,
          };
        }
      }),
      clear: vi.fn((key: string) => {
        delete mockState.sessionStoreState[key];
        if (mockState.boundPiSessionId && mockState.persistedSessionMaps[mockState.boundPiSessionId]) {
          delete mockState.persistedSessionMaps[mockState.boundPiSessionId]![key];
        }
      }),
      getAll: vi.fn(() => ({ ...mockState.sessionStoreState })),
    })),
  };
});

vi.mock("../../src/agent/provider-internal/provider-events.js", () => ({
  createEventMapper: vi.fn(() => {
    const output: any = {
      role: "assistant",
      content: [],
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const mapper = {
      stream: { push: vi.fn(), end: vi.fn() },
      output,
      listeners: {
        onMessageChunk: vi.fn(),
        onThoughtChunk: vi.fn(),
        onToolCall: vi.fn(),
        onToolCallUpdate: vi.fn(),
        onPromptComplete: vi.fn(),
        onError: vi.fn(),
        onExit: vi.fn(),
      },
      finishDone: vi.fn(() => {
        output.stopReason = "stop";
      }),
      finishWithError: vi.fn((reason: "aborted" | "error", message: string) => {
        output.stopReason = reason;
        output.errorMessage = message;
      }),
      setTargetSessionId: vi.fn(),
      setPiToolNames: vi.fn(),
      emitMcpToolCall: vi.fn((_toolName: string, _args: Record<string, unknown>, toolCallId: string) => {
        output.stopReason = "toolUse";
        output.content.push({ type: "toolCall", id: toolCallId });
        return true;
      }),
    };

    mockState.lastMapper = mapper;
    return mapper;
  }),
}));

vi.mock("@sbluemin/fleet-core/services/log", () => ({
  getLogAPI: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../src/fleet.js", () => ({
  getFleetRuntime: () => ({
    fleet: {
      tools: [],
      mcp: {
        url: vi.fn(async () => "http://127.0.0.1/test"),
        startServer: vi.fn(),
        stopServer: vi.fn(),
        registerTools: vi.fn(),
        getTools: vi.fn(() => []),
        getToolNames: vi.fn(() => new Set(["custom-tool"])),
        removeTools: vi.fn(),
        clearAllTools: vi.fn(),
        computeToolHash: vi.fn(() => "tool-hash"),
        resolveNextToolCall: vi.fn(),
        clearPendingForSession: vi.fn((token: string) => {
          mockState.clearPendingCalls.push(token);
        }),
        setOnToolCallArrived: vi.fn((token: string, cb: unknown) => {
          mockState.routerCalls.push([token, cb]);
        }),
      },
    },
  }),
}));

vi.mock("@sbluemin/fleet-core/admiral/agent-runtime", () => ({
  cleanIdleClients: vi.fn(),
  onHostSessionChange: vi.fn(),
  getSessionStore: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    getAll: vi.fn(() => ({})),
    restore: vi.fn(),
  })),
}));

import { handleSessionStart, streamAcp } from "../../src/agent/provider-internal/provider-stream.js";
import { onHostSessionChange } from "../../src/agent/provider-internal/session-runtime.js";
import { getOrInitState, resetAcpProviderState, type AcpProviderState, type AcpSessionState } from "../../src/agent/provider-internal/state.js";

describe("provider-stream", () => {
  afterEach(() => {
    mockState.client.on.mockClear();
    mockState.client.off.mockClear();
    mockState.client.connect.mockReset();
    mockState.client.sendMessage.mockReset();
    mockState.client.cancelPrompt.mockClear();
    mockState.client.endSession.mockClear();
    mockState.client.disconnect.mockClear();
    mockState.client.removeAllListeners.mockClear();
    mockState.client.getConnectionInfo.mockClear();
    mockState.client.getConnectionInfo.mockImplementation(() => ({ state: "ready", sessionId: "acp-session-1" }));
    mockState.client.connect.mockImplementation(async () => ({
      protocol: "acp",
      session: { sessionId: "acp-session-1" },
    }));
    mockState.client.sendMessage.mockImplementation(() => new Promise<void>(() => {}));
    mockState.buildArgs.length = 0;
    mockState.lastMapper = null;
    mockState.routerCalls.length = 0;
    mockState.clearPendingCalls.length = 0;
    mockState.sessionStoreState = {};
    mockState.persistedSessionMaps = {};
    mockState.boundPiSessionId = null;
    resetAcpProviderState();
  });

  it("cold host provider 연결 후 sessionId를 PI session-map에 저장한다", async () => {
    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "previous user" } as any,
          { role: "assistant", content: "previous assistant" } as any,
          { role: "user", content: "hello" } as any,
        ],
      } as any,
      { cwd: "/tmp/pi-fleet", sessionId: "pi-cold" } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.client.connect).toHaveBeenCalledTimes(1);
      expect(mockState.client.sendMessage).toHaveBeenCalledTimes(1);
    });

    expect(mockState.client.connect).toHaveBeenCalledWith(expect.not.objectContaining({
      sessionId: expect.any(String),
    }));
    expect(mockState.client.sendMessage).toHaveBeenCalledWith(expect.stringContaining("<conversation-history>"));
    expect(mockState.sessionStoreState["host:codex"]).toBe("acp-session-1");
  });

  it("저장된 host provider sessionId를 resume하면 첫 메시지를 follow-up으로 보낸다", async () => {
    mockState.persistedSessionMaps["pi-warm"] = { "host:codex": "saved-session" };

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "previous user" } as any,
          { role: "assistant", content: "previous assistant" } as any,
          { role: "user", content: "hello" } as any,
        ],
      } as any,
      { cwd: "/tmp/pi-fleet", sessionId: "pi-warm" } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.client.connect).toHaveBeenCalledTimes(1);
      expect(mockState.client.sendMessage).toHaveBeenCalledTimes(1);
    });

    expect(mockState.buildArgs).toEqual([expect.objectContaining({
      cli: "codex",
      sessionId: "saved-session",
    })]);
    expect(mockState.client.connect).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "saved-session",
    }));
    expect(onHostSessionChange).toHaveBeenCalledWith("pi-warm");
    expect(mockState.client.sendMessage).toHaveBeenCalledWith("hello");
    expect(mockState.client.sendMessage).toHaveBeenCalledWith(expect.not.stringContaining("<conversation-history>"));
    expect(mockState.sessionStoreState["host:codex"]).toBe("acp-session-1");
  });

  it("session_start 바인딩 없이 slash resume 이후 streamAcp가 PI session-map을 방어적으로 bind한다", async () => {
    mockState.persistedSessionMaps["pi-slash-resume"] = { "host:codex": "saved-session" };

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "previous user" } as any,
          { role: "assistant", content: "previous assistant" } as any,
          { role: "user", content: "hello" } as any,
        ],
      } as any,
      { cwd: "/tmp/pi-fleet", sessionId: "pi-slash-resume" } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.client.connect).toHaveBeenCalledTimes(1);
      expect(mockState.client.sendMessage).toHaveBeenCalledTimes(1);
    });

    expect(onHostSessionChange).toHaveBeenCalledWith("pi-slash-resume");
    expect(mockState.client.connect).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "saved-session",
    }));
    expect(mockState.client.sendMessage).toHaveBeenCalledWith("hello");
    expect(mockState.client.sendMessage).toHaveBeenCalledWith(expect.not.stringContaining("<conversation-history>"));
  });

  it("저장된 host provider sessionId가 dead-session이면 clear 후 fresh fallback한다", async () => {
    mockState.persistedSessionMaps["pi-fallback"] = { "host:codex": "stale-session" };
    mockState.client.connect
      .mockRejectedValueOnce(new Error("session not found: stale-session"))
      .mockResolvedValueOnce({
        protocol: "acp",
        session: { sessionId: "fresh-session" },
      });

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" } as any],
      } as any,
      { cwd: "/tmp/pi-fleet", sessionId: "pi-fallback" } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.client.connect).toHaveBeenCalledTimes(2);
      expect(mockState.client.sendMessage).toHaveBeenCalledTimes(1);
    });

    expect(mockState.client.connect).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: "stale-session",
    }));
    expect(mockState.client.connect).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      sessionId: expect.any(String),
    }));
    expect(mockState.client.sendMessage).toHaveBeenCalledWith(expect.stringContaining("<user_request>"));
    expect(mockState.sessionStoreState["host:codex"]).toBe("fresh-session");
  });

  it("저장된 host provider sessionId의 capability mismatch는 fresh fallback하지 않는다", async () => {
    mockState.persistedSessionMaps["pi-capability"] = { "host:codex": "saved-session" };
    mockState.client.connect.mockRejectedValueOnce(new Error("provider does not support session/load"));

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" } as any],
      } as any,
      { cwd: "/tmp/pi-fleet", sessionId: "pi-capability" } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.lastMapper.finishWithError).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("does not support session/load"),
      );
    });

    expect(mockState.client.connect).toHaveBeenCalledTimes(1);
    expect(mockState.sessionStoreState["host:codex"]).toBe("saved-session");
  });

  it("session_start resume은 disk session-map을 지우지 않는다", async () => {
    mockState.sessionStoreState["host:codex"] = "saved-session";

    await handleSessionStart("resume", "pi-session-1");

    expect(mockState.sessionStoreState["host:codex"]).toBe("saved-session");
  });

  it("session_start resume은 backend 세션을 archive하지 않고 연결만 닫는다", async () => {
    const session: AcpSessionState = {
      sessionKey: "acp:codex:session:pi:pi-resume",
      scopeKey: "session:pi:pi-resume",
      client: mockState.client as any,
      sessionId: "saved-session",
      cwd: "/tmp/pi-fleet",
      lastSystemPromptHash: "hash",
      cli: "codex",
      firstPromptSent: true,
      currentModel: "gpt-5.4",
      toolHash: "tool-hash",
      pendingToolCalls: [],
      pendingToolCallNotifier: null,
      activePrompt: null,
      sessionGeneration: 0,
      needsRecovery: false,
      lastError: null,
    };
    const providerState: AcpProviderState = {
      sessions: new Map([[session.sessionKey, session]]),
      sessionKeysByScope: new Map([[session.scopeKey, new Set([session.sessionKey])]]),
      toolCallToSessionKey: new Map(),
      bridgeScopeSessionKeys: new Map(),
      sessionLaunchConfigs: new Map(),
    };
    Object.assign(getOrInitState(), providerState);

    await handleSessionStart("resume", "pi-session-1");

    expect(mockState.client.endSession).not.toHaveBeenCalled();
    expect(mockState.client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("toolResult 이후 즉시 다음 toolUse로 끊겨도 listener와 abort cleanup을 실행한다", async () => {
    const signal = new AbortController().signal;
    const removeEventListenerSpy = vi.spyOn(signal, "removeEventListener");

    const session: AcpSessionState = {
      sessionKey: "acp:codex:session:pi:pi-turn",
      scopeKey: "session:pi:pi-turn",
      client: mockState.client as any,
      sessionId: "acp-session-1",
      cwd: "/tmp/pi-fleet",
      lastSystemPromptHash: "hash",
      cli: "codex",
      firstPromptSent: true,
      currentModel: "gpt-5.4",
      mcpSessionToken: "token-1",
      toolHash: "tool-hash",
      pendingToolCalls: [
        { toolCallId: "call-1", toolName: "custom-tool", args: {}, emitted: true },
        { toolCallId: "call-2", toolName: "custom-tool", args: { next: true }, emitted: false },
      ],
      pendingToolCallNotifier: null,
      activePrompt: {
        promptId: "prompt-1",
        sessionGeneration: 0,
        retryConsumed: false,
        assistantOutputStarted: false,
        builtinToolStarted: false,
        mcpToolUseStarted: true,
      },
      sessionGeneration: 0,
      needsRecovery: false,
      lastError: null,
    };

    const providerState: AcpProviderState = {
      sessions: new Map([[session.sessionKey, session]]),
      sessionKeysByScope: new Map([[session.scopeKey, new Set([session.sessionKey])]]),
      toolCallToSessionKey: new Map([
        ["call-1", session.sessionKey],
        ["call-2", session.sessionKey],
      ]),
      bridgeScopeSessionKeys: new Map(),
      sessionLaunchConfigs: new Map(),
    };
    Object.assign(getOrInitState(), providerState);

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "toolResult",
            content: "done",
            toolCallId: "call-1",
          } as any,
        ],
      } as any,
      {
        cwd: "/tmp/pi-fleet",
        sessionId: "pi-turn",
        signal,
      } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.client.off).toHaveBeenCalled();
    });

    expect(mockState.client.off).toHaveBeenCalledTimes(8);
    expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(session.pendingToolCallNotifier).toBeNull();
    expect(mockState.routerCalls).not.toContainEqual(["token-1", null]);
    expect(mockState.clearPendingCalls).toEqual([]);
  });

  it("terminal stop cleanup에서는 router를 분리하고 pending MCP 상태를 정리한다", async () => {
    const session: AcpSessionState = {
      sessionKey: "acp:codex:session:pi:terminal",
      scopeKey: "session:pi:terminal",
      client: mockState.client as any,
      sessionId: "acp-session-1",
      cwd: "/tmp/pi-fleet",
      lastSystemPromptHash: "hash",
      cli: "codex",
      firstPromptSent: true,
      currentModel: "gpt-5.4",
      mcpSessionToken: "token-terminal",
      toolHash: "tool-hash",
      pendingToolCalls: [
        { toolCallId: "call-1", toolName: "custom-tool", args: {}, emitted: true },
      ],
      pendingToolCallNotifier: null,
      activePrompt: {
        promptId: "prompt-2",
        sessionGeneration: 0,
        retryConsumed: false,
        assistantOutputStarted: false,
        builtinToolStarted: false,
        mcpToolUseStarted: true,
      },
      sessionGeneration: 0,
      needsRecovery: false,
      lastError: null,
    };

    const providerState: AcpProviderState = {
      sessions: new Map([[session.sessionKey, session]]),
      sessionKeysByScope: new Map([[session.scopeKey, new Set([session.sessionKey])]]),
      toolCallToSessionKey: new Map([["call-1", session.sessionKey]]),
      bridgeScopeSessionKeys: new Map(),
      sessionLaunchConfigs: new Map(),
    };
    Object.assign(getOrInitState(), providerState);

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "toolResult",
            content: "done",
            toolCallId: "call-1",
          } as any,
        ],
      } as any,
      {
        cwd: "/tmp/pi-fleet",
        sessionId: "terminal",
      } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.client.on).toHaveBeenCalledTimes(8);
      expect(mockState.lastMapper).toBeTruthy();
    });

    mockState.lastMapper.finishDone();

    expect(mockState.routerCalls).toContainEqual(["token-terminal", null]);
    expect(mockState.clearPendingCalls).toEqual(["token-terminal"]);
    expect(session.pendingToolCalls).toEqual([]);
    expect(providerState.toolCallToSessionKey.has("call-1")).toBe(false);
  });

  it("abort cleanup에서는 router를 분리해 늦은 call이 orphan으로 남지 않게 한다", async () => {
    const controller = new AbortController();

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: "hello",
          } as any,
        ],
        tools: [
          {
            name: "custom-tool",
            description: "custom",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as any,
      {
        cwd: "/tmp/pi-fleet",
        sessionId: "abort-case",
        signal: controller.signal,
      } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.routerCalls.some(([token, cb]) => token.length > 0 && typeof cb === "function")).toBe(true);
    });

    controller.abort();

    await vi.waitFor(() => {
      expect(mockState.routerCalls.some(([token, cb]) => token.length > 0 && cb === null)).toBe(true);
    });

    expect(mockState.clearPendingCalls.length).toBeGreaterThan(0);
    expect(mockState.client.cancelPrompt).toHaveBeenCalledTimes(1);
  });

  it("toolUse 이후 dead-session 상태에서는 stale toolResult를 폐기하고 새 세션을 열지 않는다", async () => {
    const session: AcpSessionState = {
      sessionKey: "acp:codex:session:pi:stale",
      scopeKey: "session:pi:stale",
      client: mockState.client as any,
      sessionId: "acp-session-1",
      cwd: "/tmp/pi-fleet",
      lastSystemPromptHash: "hash",
      cli: "codex",
      firstPromptSent: true,
      currentModel: "gpt-5.4",
      mcpSessionToken: "token-stale",
      toolHash: "tool-hash",
      pendingToolCalls: [
        { toolCallId: "call-1", toolName: "custom-tool", args: {}, emitted: true },
      ],
      pendingToolCallNotifier: null,
      activePrompt: {
        promptId: "prompt-stale",
        sessionGeneration: 0,
        retryConsumed: true,
        assistantOutputStarted: false,
        builtinToolStarted: false,
        mcpToolUseStarted: true,
      },
      sessionGeneration: 0,
      needsRecovery: true,
      lastError: "unknown session",
    };

    const providerState: AcpProviderState = {
      sessions: new Map([[session.sessionKey, session]]),
      sessionKeysByScope: new Map([[session.scopeKey, new Set([session.sessionKey])]]),
      toolCallToSessionKey: new Map([["call-1", session.sessionKey]]),
      bridgeScopeSessionKeys: new Map(),
      sessionLaunchConfigs: new Map(),
    };
    Object.assign(getOrInitState(), providerState);

    streamAcp(
      { id: "gpt-5.4", provider: "Fleet ACP", reasoning: true } as any,
      {
        systemPrompt: "system",
        messages: [{ role: "toolResult", content: "done", toolCallId: "call-1" } as any],
      } as any,
      { cwd: "/tmp/pi-fleet", sessionId: "stale" } as any,
    );

    await vi.waitFor(() => {
      expect(mockState.lastMapper.finishWithError).toHaveBeenCalled();
    });

    expect(mockState.lastMapper.finishWithError).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("stale toolResult"),
    );
    expect(mockState.client.on).not.toHaveBeenCalled();
  });
});
