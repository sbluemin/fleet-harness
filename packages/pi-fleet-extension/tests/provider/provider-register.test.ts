import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
}));

vi.mock("@sbluemin/unified-agent", () => ({
  getModelsRegistry: () => ({
    providers: {
      codex: {
        name: "OpenAI Codex CLI",
        models: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
        reasoningEffort: {
          supported: true,
          levels: ["none", "low", "medium", "high", "xhigh"],
          default: "high",
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

vi.mock("@sbluemin/fleet-core/services/log", () => ({
  getLogAPI: () => ({
    debug: vi.fn(),
    registerCategory: vi.fn(),
  }),
}));

vi.mock("@sbluemin/fleet-core/services/settings", () => ({
  getSettingsService: () => ({
    load: vi.fn(() => ({})),
    save: vi.fn(),
  }),
}));

vi.mock("@sbluemin/fleet-core", () => ({
  buildModelId: (_cli: string, model: string) => `${model} (Unified)`,
  buildProviderId: (_cli: string) => "OpenAI Codex CLI",
  getProviderIds: () => ["OpenAI Codex CLI"],
  parseModelId: (_id: string) => ({ cli: "codex", backendModel: "gpt-5.4" }),
  getThinkingLevels: () => ["off", "low", "medium", "high", "xhigh"],
  bindHostSession: vi.fn(),
  shutdownAllSessions: vi.fn(async () => {}),
}));

import registerProviderRuntime from "../../src/provider.js";
import { bindHostSession } from "@sbluemin/fleet-core";

describe("provider register", () => {
  it("provider/model 등록 라벨을 Unified 표기로 노출한다", () => {
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
            id: "gpt-5.4 (Unified)",
            name: "GPT-5.4",
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

    sessionStart?.(
      { reason: "resume" },
      {
        model: { id: "GPT-5.4 (Unified)" },
        sessionManager: {
          getSessionId: () => "pi-session-resume",
        },
      },
    );

    expect(bindHostSession).toHaveBeenCalledWith("pi-session-resume");
  });
});
