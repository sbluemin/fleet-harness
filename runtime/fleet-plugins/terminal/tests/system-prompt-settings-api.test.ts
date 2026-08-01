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
      agentIdleDormantMinutes: 60,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  it("saves the prompt boolean to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: true, agentIdleDormantMinutes: 60 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ enableMetaphor: true })).resolves.toEqual({
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
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agentIdleDormantMinutes: 60 })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("rejects responses missing agentIdleDormantMinutes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ enableMetaphor: false })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("saves agentIdleDormantMinutes including null Off", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      agentIdleDormantMinutes: null,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ agentIdleDormantMinutes: null })).resolves.toEqual({
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
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as Response;
}
