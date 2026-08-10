import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSystemPromptSettings, saveSystemPromptSettings } from "../client/agent/settings.js";

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
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  it.each(["append", "replace", "off"] as const)(
    "saves and accepts the Claude Gateway system prompt mode %s",
    async (mode) => {
      const fetchMock = vi.fn(async () => jsonResponse({
        agentIdleDormantMinutes: 60,
        aiGateway: null,
        aiGatewayCatalog: EMPTY_CATALOG,
        cursorDiagnosticsEnabled: false,
        wireLogEnabled: false,
        claudeGatewaySystemPromptMode: mode,
      }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(saveSystemPromptSettings({ claudeGatewaySystemPromptMode: mode })).resolves.toMatchObject({
        claudeGatewaySystemPromptMode: mode,
      });
      expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewaySystemPromptMode: mode }),
        signal: undefined,
      });
    },
  );

  it("rejects an invalid system prompt mode in a response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "invalid",
    })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves Cursor diagnostics to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      cursorDiagnosticsEnabled: true,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ cursorDiagnosticsEnabled: true })).resolves.toMatchObject({
      cursorDiagnosticsEnabled: true,
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
      agentIdleDormantMinutes: 60,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
    })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing the Cursor diagnostics setting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      agentIdleDormantMinutes: 60,
      aiGatewayCatalog: EMPTY_CATALOG,
    })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves agentIdleDormantMinutes including null Off", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      agentIdleDormantMinutes: null,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ agentIdleDormantMinutes: null })).resolves.toMatchObject({
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
      agentIdleDormantMinutes: 60,
      aiGateway,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
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
      agentIdleDormantMinutes: 60,
      aiGatewayCatalog: EMPTY_CATALOG,
      cursorDiagnosticsEnabled: false,
    })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves Cursor diagnostics independently from the gateway selection", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: true,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ cursorDiagnosticsEnabled: true })).resolves.toMatchObject({
      cursorDiagnosticsEnabled: true,
      wireLogEnabled: false,
      claudeGatewaySystemPromptMode: "append",
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
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: true,
      claudeGatewaySystemPromptMode: "append",
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
