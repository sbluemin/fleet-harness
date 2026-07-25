import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSystemPromptSettings, saveSystemPromptSettings } from "../client/agent/settings-api.js";

describe("system prompt settings api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads Terminal prompt settings from the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: false, agentIdleDormantMinutes: 60 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({
      enableMetaphor: false,
      kimiModel: null,
      agentIdleDormantMinutes: 60,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  it("saves the prompt boolean to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: true, agentIdleDormantMinutes: 60 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ enableMetaphor: true })).resolves.toEqual({
      enableMetaphor: true,
      kimiModel: null,
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
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ kimiModel: null })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing agentIdleDormantMinutes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ enableMetaphor: false, kimiModel: null })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("loads the stored Kimi default model from the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      kimiModel: { model: "k3", effort: "low" },
      agentIdleDormantMinutes: 60,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({
      enableMetaphor: false,
      kimiModel: { model: "k3", effort: "low" },
      agentIdleDormantMinutes: 60,
    });
  });

  it("saves the Kimi default model to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      kimiModel: { model: "k3[1m]", effort: "high" },
      agentIdleDormantMinutes: 60,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ kimiModel: { model: "k3[1m]", effort: "high" } })).resolves.toEqual({
      enableMetaphor: false,
      kimiModel: { model: "k3[1m]", effort: "high" },
      agentIdleDormantMinutes: 60,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kimiModel: { model: "k3[1m]", effort: "high" } }),
      signal: undefined,
    });
  });

  it("saves agentIdleDormantMinutes including null Off", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      kimiModel: null,
      agentIdleDormantMinutes: null,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ agentIdleDormantMinutes: null })).resolves.toEqual({
      enableMetaphor: false,
      kimiModel: null,
      agentIdleDormantMinutes: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentIdleDormantMinutes: null }),
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
