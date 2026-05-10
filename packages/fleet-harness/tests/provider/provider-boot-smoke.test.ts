import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  bindHostSessionMock: vi.fn(),
  shutdownAllSessionsMock: vi.fn(async () => {}),
}));

vi.mock("@sbluemin/fleet-unified-agent", () => ({
  CLI_BACKENDS: {},
  getEffort: vi.fn(() => ({
    supported: true,
    levels: ["low", "medium", "high", "xhigh"],
    default: "high",
  })),
  getModelsRegistry: () => ({ providers: {} }),
}));

vi.mock("@sbluemin/fleet-core", () => ({
  admiral: {
    agent: {
      lifecycle: {
        bindHostSession: mockState.bindHostSessionMock,
        shutdownAllSessions: mockState.shutdownAllSessionsMock,
      },
      models: {
        buildModelId: vi.fn(),
        buildProviderId: vi.fn(),
        getSelectableThinkingLevels: vi.fn(() => null),
        hashSystemPrompt: vi.fn(() => "hash-boot"),
        parseModelId: vi.fn(() => ({ cli: "codex", backendModel: "gpt-5.4" })),
      },
      session: {
        ensure: vi.fn(),
        sendMessage: vi.fn(),
        deliverToolResults: vi.fn(),
      },
      tools: { registerExtraTools: vi.fn() },
      events: { registerStreamHandler: vi.fn() },
    },
  },
  infra: {
    log: {
      getLogAPI: () => ({
        registerCategory: vi.fn(),
      }),
    },
  },
}));

import registerProviderRuntime from "../../src/provider.js";

describe("provider boot smoke", () => {
  it("zero-provider host boot path가 crash 없이 살아남는다", () => {
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        mockState.handlers.set(event, handler);
      }),
      registerProvider: vi.fn(),
    };

    registerProviderRuntime(pi as any, {} as any, vi.fn());

    expect(pi.registerProvider).not.toHaveBeenCalled();

    const sessionStart = mockState.handlers.get("session_start");
    expect(sessionStart).toBeTruthy();

    const sessionManager = {
      getSessionId: () => "pi-session-boot",
    };

    expect(() =>
      sessionStart?.(
        { reason: "boot" },
        {
          model: undefined,
          sessionManager,
        },
      ),
    ).not.toThrow();

    expect(mockState.bindHostSessionMock).toHaveBeenCalledWith("pi-session-boot", sessionManager);
  });
});
