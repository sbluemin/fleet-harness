import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSystemPromptSettings, saveSystemPromptSettings } from "../client/agent/settings-api.js";

const EMPTY_CATALOG = { providers: [] };
const CATALOG = {
  providers: [
    {
      id: "cursor",
      models: [
        {
          id: "cursor--claude-opus-5",
          name: "Opus-5",
          contextWindow: 300000,
          oneMillion: true,
          maxMode: false,
          fast: false,
          description: null,
          effort: { levels: ["low", "medium", "high", "xhigh", "max"] },
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
      enableMetaphor: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({
      enableMetaphor: false,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: CATALOG,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  it("saves the prompt boolean to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: true,
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ enableMetaphor: true })).resolves.toMatchObject({
      enableMetaphor: true,
      agentIdleDormantMinutes: 60,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enableMetaphor: true }),
      signal: undefined,
    });
  });

  it("rejects responses missing a required settings field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agentIdleDormantMinutes: 60, aiGatewayCatalog: EMPTY_CATALOG })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing agentIdleDormantMinutes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ enableMetaphor: false, aiGatewayCatalog: EMPTY_CATALOG })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing the gateway catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ enableMetaphor: false, agentIdleDormantMinutes: 60 })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves agentIdleDormantMinutes including null Off", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      agentIdleDormantMinutes: null,
      aiGateway: null,
      aiGatewayCatalog: EMPTY_CATALOG,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ agentIdleDormantMinutes: null })).resolves.toMatchObject({
      enableMetaphor: false,
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
      models: [{ id: "cursor--claude-opus-5" }],
      defaultModel: "cursor--claude-opus-5",
    };
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      agentIdleDormantMinutes: 60,
      aiGateway,
      aiGatewayCatalog: CATALOG,
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
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as Response;
}
