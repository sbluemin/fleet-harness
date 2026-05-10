import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sbluemin/fleet-ai", () => ({
  createAssistantMessageEventStream: () => ({
    push: vi.fn(),
    end: vi.fn(),
  }),
}));

let capturedStreamHandler: Function | null = null;
const parseModelIdMock = vi.fn((id: string, _provider?: string) => {
  if (id === "gpt-5.4 (Unified)" || id === "gpt-5.4") return { cli: "codex", backendModel: "gpt-5.4" };
  return null;
});
const ensureMock = vi.fn(async () => ({ sessionId: "acp-session-1" }));
const sendMessageMock = vi.fn(async () => {});
const deliverToolResultsMock = vi.fn(async () => {});

vi.mock("@sbluemin/fleet-core", () => ({
  admiral: {
    agent: {
      models: {
        parseModelId: parseModelIdMock,
        hashSystemPrompt: vi.fn(() => "hash-123"),
        buildModelId: vi.fn((cli: string, modelId: string) => `${modelId} (${cli})`),
        buildProviderId: vi.fn((cli: string) => `provider-${cli}`),
        getProviderIds: vi.fn(() => []),
        getSelectableThinkingLevels: vi.fn(() => null),
      },
      session: {
        ensure: ensureMock,
        sendMessage: sendMessageMock,
        deliverToolResults: deliverToolResultsMock,
        resolveSession: vi.fn(() => null),
      },
      tools: { registerExtraTools: vi.fn() },
      events: {
        registerStreamHandler: vi.fn((handler: Function) => {
          capturedStreamHandler = handler;
          return () => { capturedStreamHandler = null; };
        }),
      },
      bridge: { buildLaunchCommand: vi.fn(() => null) },
      lifecycle: {
        bindHostSession: vi.fn(),
        shutdownAllSessions: vi.fn(async () => {}),
      },
    },
  },
  infra: {
    log: { getLogAPI: vi.fn(() => ({ registerCategory: vi.fn() })) },
    settings: { getSettingsService: vi.fn(() => null) },
  },
}));

vi.mock("@sbluemin/fleet-unified-agent", () => ({
  CLI_BACKENDS: {},
  getEffort: vi.fn(() => ({
    supported: true,
    levels: ["low", "medium", "high", "xhigh"],
    default: "high",
  })),
  getModelsRegistry: vi.fn(() => ({ providers: {} })),
}));

vi.mock("@sbluemin/fleet-coding-agent", () => ({
  AgentSession: class { },
}));

describe("provider-stream adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedStreamHandler = null;
  });

  it("잘못된 model ID는 에러 스트림을 반환한다", async () => {
    vi.resetModules();
    const { streamAcp } = await import("../../src/provider.js");
    const parseModelId = parseModelIdMock;

    vi.mocked(parseModelId).mockReturnValueOnce(null);

    const stream = streamAcp(
      { id: "invalid-model", provider: "unknown" } as any,
      { messages: [{ role: "user", content: "hello" }] } as any,
      { cwd: "/tmp", sessionId: "pi-1" } as any,
    );

    expect(stream).toBeDefined();
  });

  it("fresh query는 ensure → sendMessage(SendMessageRequest)를 호출한다", async () => {
    vi.resetModules();
    const { streamAcp, initStreamEventHandler } = await import("../../src/provider.js");
    const ensure = ensureMock;
    const sendMessage = sendMessageMock;

    initStreamEventHandler();
    vi.mocked(ensure).mockResolvedValueOnce({ sessionId: "acp-session-1" });
    vi.mocked(sendMessage).mockResolvedValueOnce(undefined);

    streamAcp(
      { id: "gpt-5.4 (Unified)", provider: "OpenAI Codex CLI" } as any,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
      } as any,
      { cwd: "/tmp", sessionId: "pi-fresh" } as any,
    );

    await vi.waitFor(() => {
      expect(ensure).toHaveBeenCalledWith(
        expect.objectContaining({
          cli: "codex",
          backendModel: "gpt-5.4",
          scopeKey: "session:pi:pi-fresh",
          cwd: "/tmp",
          systemPrompt: "system",
        }),
      );
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        { sessionId: "acp-session-1" },
        expect.objectContaining({ userRequest: "hello" }),
        undefined,
      );
    });
  });

  it("toolResult delivery는 mcpToolCall 이벤트에서 등록된 sessionId로 라우팅한다", async () => {
    vi.resetModules();
    const { streamAcp, initStreamEventHandler } = await import("../../src/provider.js");
    const ensure = ensureMock;
    const sendMessage = sendMessageMock;
    const deliverToolResults = deliverToolResultsMock;

    initStreamEventHandler();
    vi.mocked(ensure).mockResolvedValueOnce({ sessionId: "acp-session-1" });
    vi.mocked(sendMessage).mockResolvedValueOnce(undefined);

    streamAcp(
      { id: "gpt-5.4 (Unified)", provider: "OpenAI Codex CLI" } as any,
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "test-tool", description: "test", parameters: {} }],
      } as any,
      { cwd: "/tmp", sessionId: "pi-tool" } as any,
    );

    await vi.waitFor(() => {
      expect(ensure).toHaveBeenCalled();
    });

    expect(capturedStreamHandler).toBeTruthy();
    capturedStreamHandler?.({
      type: "mcpToolCall",
      sessionId: "acp-session-1",
      toolCallId: "test-call-id",
      name: "test-tool",
      args: {},
    });

    vi.mocked(deliverToolResults).mockResolvedValueOnce(undefined);

    streamAcp(
      { id: "gpt-5.4 (Unified)", provider: "OpenAI Codex CLI" } as any,
      {
        messages: [
          {
            role: "toolResult",
            content: "done",
            toolCallId: "test-call-id",
          } as any,
        ],
      } as any,
      { cwd: "/tmp", sessionId: "pi-tool" } as any,
    );

    await vi.waitFor(() => {
      expect(deliverToolResults).toHaveBeenCalledWith(
        { sessionId: "acp-session-1" },
        expect.arrayContaining([
          expect.objectContaining({
            toolCallId: "test-call-id",
            content: "done",
          }),
        ]),
        undefined,
      );
    });
  });
});
