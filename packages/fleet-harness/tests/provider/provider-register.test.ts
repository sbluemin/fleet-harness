import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
}));

const mockFleetCore = vi.hoisted(() => ({
  bindHostSession: vi.fn(),
}));

vi.mock("@sbluemin/fleet-unified-agent", () => ({
  getEffort: () => ({
    supported: true,
    levels: ["low", "medium", "high", "xhigh", "max"],
    default: "xhigh",
  }),
  getModelsRegistry: () => ({
    providers: {
      codex: {
        name: "OpenAI Codex CLI",
        models: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
        effort: {
          supported: true,
          levels: ["low", "medium", "high", "xhigh", "max"],
          default: "xhigh",
        },
      },
    },
  }),
  CLI_BACKENDS: {
    codex: {
      supportsSessionClose: true,
      supportsSessionLoad: true,
      requiresModelAtSpawn: false,
      usesNpxBridge: false,
      defaultMaxTokens: 100_000,
    },
  },
}));

vi.mock("@sbluemin/fleet-core", () => ({
  admiral: {
    agent: {
      lifecycle: {
        bindHostSession: mockFleetCore.bindHostSession,
        shutdownAllSessions: vi.fn(async () => {}),
      },
      models: {
        buildModelId: (_cli: string, model: string) => model,
        buildProviderId: (_cli: string) => "OpenAI Codex CLI",
        getProviderIds: () => ["OpenAI Codex CLI"],
        parseModelId: (_id: string) => ({ cli: "codex", backendModel: "gpt-5.4" }),
        getSelectableThinkingLevels: () => ["off", "low", "medium", "high", "xhigh"],
      },
      events: { registerStreamHandler: vi.fn() },
      session: {},
      tools: { registerExtraTools: vi.fn() },
    },
  },
  infra: {
    log: {
      getLogAPI: () => ({
        debug: vi.fn(),
        registerCategory: vi.fn(),
      }),
    },
    settings: {
      getSettingsService: () => ({
        load: vi.fn(() => ({})),
        save: vi.fn(),
      }),
    },
  },
}));

import registerProviderRuntime from "../../src/provider.js";

describe("provider register", () => {
  it("provider/model 등록 라벨을 models.json model.name으로 노출한다", () => {
    const streamAcp = vi.fn();

    const fleetServices = {} as any;
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        mockState.handlers.set(event, handler);
      }),
      registerProvider: vi.fn(),
    };

    registerProviderRuntime(pi as any, fleetServices, streamAcp);

    expect(pi.registerProvider).toHaveBeenCalledWith(
      "OpenAI Codex CLI",
      expect.objectContaining({
        baseUrl: "OpenAI Codex CLI",
        api: "OpenAI Codex CLI",
        models: [
          expect.objectContaining({
            id: "gpt-5.4",
            name: "GPT-5.4",
            reasoning: true,
            defaultThinkingLevel: "xhigh",
            thinkingLevelMap: {
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
          }),
        ],
      }),
    );
  });

  it("session_start에서 bindHostSession을 호출한다", async () => {
    const streamAcp = vi.fn();

    const fleetServices = {} as any;
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        mockState.handlers.set(event, handler);
      }),
      registerProvider: vi.fn(),
    };

    registerProviderRuntime(pi as any, fleetServices, streamAcp);

    const sessionStart = mockState.handlers.get("session_start");
    expect(sessionStart).toBeTruthy();

    const sessionManager = {
      getSessionId: () => "pi-session-resume",
    };

    sessionStart?.(
      { reason: "resume" },
      {
        model: { id: "GPT-5.4" },
        sessionManager,
      },
    );

    expect(mockFleetCore.bindHostSession).toHaveBeenCalledWith("pi-session-resume", sessionManager);
  });
});
