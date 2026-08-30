import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchSystemPromptSettings,
  loadSystemPromptSettings,
  saveSystemPromptSettings,
  setSystemPromptSettingsField,
  type SystemPromptSettingsField,
  type SystemPromptSettingsState,
} from "../client/agent/settings.js";

const EMPTY_CATALOG = { providers: [] };
const CATALOG = {
  providers: [
    {
      id: "cursor",
      models: [
        {
          id: "cursor--grok-4.5",
          name: "Grok-4.5",
          contextWindow: 256000,
          oneMillion: true,
          maxMode: false,
          fast: false,
          capabilityClass: "flagship",
          description: null,
          effort: { levels: ["low", "medium", "high"] },
        },
      ],
    },
  ],
};

describe("system prompt settings api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads Terminal prompt settings from the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  /**
   * 저장 매핑은 후미 폴백을 가진 if 사슬이라, 분기를 빠뜨린 필드는 오류 없이 **다른 설정**을
   * 저장한다. 실제로 승인 게이트 옵트인이 그렇게 휴면 시간을 저장했다. 필드 목록 전체를 돌며
   * 요청 본문의 키가 그 필드와 같은지 본다 — 다음 필드가 같은 함정에 빠지면 여기서 걸린다.
   */
  it("sends each settings field under its own key", async () => {
    const FIELDS: readonly SystemPromptSettingsField[] = [
      "agentIdleDormantMinutes",
      "claudeCodeSystemPrompt",
      "claudeCodeSkipPermissions",
      "aiGateway",
      "cursorDiagnosticsEnabled",
      "wireLogEnabled",
      "compactCeiling",
      "xaiEndpoint",
    ];
    const state: SystemPromptSettingsState = {
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct",
    };
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") bodies.push(String(init.body));
      return jsonResponse(state);
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadSystemPromptSettings();

    for (const field of FIELDS) {
      bodies.length = 0;
      await setSystemPromptSettingsField(field, state[field] as never);
      expect(Object.keys(JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>)).toEqual([field]);
    }
  });

  it("rejects a settings payload that omits the permission opt-in", async () => {
    // 이 필드가 없는 응답은 옛 서버이거나 다른 무엇이다. 없는 것을 false로 읽으면
    // 화면은 게이트가 살아 있다고 말하면서 실제 런치는 바이패스일 수 있다.
    const fetchMock = vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves Cursor diagnostics to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      cursorDiagnosticsEnabled: true,
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ cursorDiagnosticsEnabled: true })).resolves.toMatchObject({
      cursorDiagnosticsEnabled: true,
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursorDiagnosticsEnabled: true }),
      signal: undefined,
    });
  });

  it("rejects responses missing a required settings field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agentIdleDormantMinutes: 60, aiGatewayCatalog: EMPTY_CATALOG })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing agentIdleDormantMinutes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ aiGatewayCatalog: EMPTY_CATALOG })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing the gateway catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing the Cursor diagnostics setting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGatewayCatalog: EMPTY_CATALOG,
    })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves the Claude Code system prompt switch to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "off",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ claudeCodeSystemPrompt: "off" })).resolves.toMatchObject({
      claudeCodeSystemPrompt: "off",
      claudeCodeSkipPermissions: false,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claudeCodeSystemPrompt: "off" }),
      signal: undefined,
    });
  });

  it("saves agentIdleDormantMinutes including null Off", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: null,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ agentIdleDormantMinutes: null })).resolves.toMatchObject({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentIdleDormantMinutes: null }),
      signal: undefined,
    });
  });

  it("saves the aiGateway selection to the plugin route", async () => {
    const aiGateway = {
      models: [{ id: "cursor--grok-4.5" }],
    };
    const fetchMock = vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ aiGateway })).resolves.toMatchObject({ aiGateway });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiGateway }),
      signal: undefined,
    });
  });

  it("rejects responses missing the wire log setting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
    })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves Cursor diagnostics independently from the gateway selection", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: true,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ cursorDiagnosticsEnabled: true })).resolves.toMatchObject({
      cursorDiagnosticsEnabled: true,
      wireLogEnabled: false,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursorDiagnosticsEnabled: true }),
      signal: undefined,
    });
  });

  it("saves the wire log setting independently from Cursor diagnostics", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      claudeCodeSystemPrompt: "on",
      claudeCodeSkipPermissions: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: true,
      compactCeiling: null,
      xaiEndpoint: "direct" as const,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ wireLogEnabled: true })).resolves.toMatchObject({
      wireLogEnabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wireLogEnabled: true }),
      signal: undefined,
    });
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as Response;
}
