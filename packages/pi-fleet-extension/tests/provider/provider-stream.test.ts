import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  createAssistantMessageEventStream: () => ({
    push: vi.fn(),
    end: vi.fn(),
  }),
}));

let capturedStreamHandler: Function | null = null;

vi.mock("@sbluemin/fleet-core", () => ({
  parseModelId: vi.fn((id: string, _provider?: string) => {
    if (id === "gpt-5.4 (Unified)" || id === "gpt-5.4") return { cli: "codex", backendModel: "gpt-5.4" };
    return null;
  }),
  hashSystemPrompt: vi.fn(() => "hash-123"),
  ensure: vi.fn(async () => ({ sessionId: "acp-session-1" })),
  sendMessage: vi.fn(async () => {}),
  deliverToolResults: vi.fn(async () => {}),
  registerExtraTools: vi.fn(),
  registerStreamHandler: vi.fn((handler: Function) => {
    capturedStreamHandler = handler;
    return () => { capturedStreamHandler = null; };
  }),
  resolveSession: vi.fn(() => null),
  buildLaunchCommand: vi.fn(() => null),
  buildModelId: vi.fn((cli: string, modelId: string) => `${modelId} (${cli})`),
  buildProviderId: vi.fn((cli: string) => `provider-${cli}`),
  getProviderIds: vi.fn(() => []),
  getThinkingLevels: vi.fn(() => null),
  bindHostSession: vi.fn(),
  shutdownAllSessions: vi.fn(async () => {}),
}));

vi.mock("@sbluemin/fleet-core/services/log", () => ({
  getLogAPI: vi.fn(() => ({ registerCategory: vi.fn() })),
}));

vi.mock("@sbluemin/fleet-core/services/settings", () => ({
  getSettingsService: vi.fn(() => null),
}));

vi.mock("@sbluemin/unified-agent", () => ({
  CLI_BACKENDS: {},
  getModelsRegistry: vi.fn(() => ({ providers: {} })),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AgentSession: class { },
}));

describe("provider-stream adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedStreamHandler = null;
  });

  it("잘못된 model ID는 에러 스트림을 반환한다", async () => {
    vi.resetModules();
    const { streamAcp } = await import("../../src/agent/provider.js");
    const { parseModelId } = await import("@sbluemin/fleet-core");

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
    const { streamAcp, initStreamEventHandler } = await import("../../src/agent/provider.js");
    const { ensure, sendMessage } = await import("@sbluemin/fleet-core");

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
    const { streamAcp, initStreamEventHandler } = await import("../../src/agent/provider.js");
    const { ensure, sendMessage, deliverToolResults } = await import("@sbluemin/fleet-core");

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
