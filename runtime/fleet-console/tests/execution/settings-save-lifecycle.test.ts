import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemPromptSettingsState } from "../../core/client/src/agent/settings.js";

const BASE: SystemPromptSettingsState = {
  agentIdleDormantMinutes: 60,
  claudeCodeSystemPrompt: "on",
  claudeCodeSkipPermissions: false,
  claudeCodeDisabledAgents: [],
  aiGateway: null,
  aiGatewayCatalog: { providers: [] },
  cursorDiagnosticsEnabled: false,
  wireLogEnabled: false,
  compactCeiling: null,
  xaiEndpoint: "cli-proxy",
};

const response = (state: SystemPromptSettingsState) => new Response(JSON.stringify(state));

// 저장 응답 경합은 HTTP 라우트 테스트로 잡히지 않는다. 설정값·실패 복원의 경계를 검증한다.
describe("terminal settings save lifecycle", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("keeps independent saves and failures isolated while preventing duplicate writes", async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return Promise.resolve(response(BASE));
      return new Promise<Response>((resolve) => pending.set(Object.keys(JSON.parse(init.body as string))[0]!, resolve));
    }));
    const store = await import("../../core/client/src/agent/settings.js");
    await store.loadSystemPromptSettings();
    const permission = store.setSystemPromptSettingsField("claudeCodeSkipPermissions", true);
    const prompt = store.setSystemPromptSettingsField("claudeCodeSystemPrompt", "off");
    await expect(store.setSystemPromptSettingsField("claudeCodeSkipPermissions", false)).resolves.toBe(false);
    expect(store.getSystemPromptSettingsStoreState().savingFields.size).toBe(2);
    pending.get("claudeCodeSkipPermissions")!(new Response(JSON.stringify({ error: "permission write refused" }), { status: 500 }));
    await expect(permission).resolves.toBe(false);
    pending.get("claudeCodeSystemPrompt")!(response({ ...BASE, claudeCodeSystemPrompt: "off" }));
    await expect(prompt).resolves.toBe(true);
    expect(store.getSystemPromptSettingsStoreState()).toMatchObject({
      state: { claudeCodeSkipPermissions: false, claudeCodeSystemPrompt: "off" },
      error: "permission write refused",
    });
    expect(store.getSystemPromptSettingsStoreState().savingFields.size).toBe(0);
  });

  it("ignores stale reads after saving and settles cancelled loads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(BASE));
    vi.stubGlobal("fetch", fetchMock);
    const store = await import("../../core/client/src/agent/settings.js");
    await store.loadSystemPromptSettings();
    let resolveRead!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRead = resolve; }));
    const read = store.loadSystemPromptSettings();
    fetchMock.mockResolvedValueOnce(response({ ...BASE, claudeCodeSkipPermissions: true }));
    await store.setSystemPromptSettingsField("claudeCodeSkipPermissions", true);
    resolveRead(response(BASE));
    await read;
    expect(store.getSystemPromptSettingsStoreState().state?.claudeCodeSkipPermissions).toBe(true);
    expect(store.getSystemPromptSettingsStoreState().loading).toBe(false);

    const controller = new AbortController();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRead = resolve; }));
    const cancelled = store.loadSystemPromptSettings(controller.signal);
    controller.abort();
    resolveRead(response(BASE));
    await cancelled;
    expect(store.getSystemPromptSettingsStoreState().loading).toBe(false);
    expect(store.getSystemPromptSettingsStoreState().state?.claudeCodeSkipPermissions).toBe(true);
  });
});
