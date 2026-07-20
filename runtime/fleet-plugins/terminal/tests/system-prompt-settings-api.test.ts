import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSystemPromptSettings, saveSystemPromptSettings } from "../client/agent/settings-api.js";

describe("system prompt settings api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads Terminal prompt settings from the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: false, codexLaunchMode: "acp" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({ enableMetaphor: false, codexLaunchMode: "acp", kimiModel: null });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  it("saves the prompt boolean to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: true, codexLaunchMode: "acp" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ enableMetaphor: true })).resolves.toEqual({ enableMetaphor: true, codexLaunchMode: "acp", kimiModel: null });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enableMetaphor: true }),
      signal: undefined,
    });
  });

  it("saves the Codex launch mode to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: false, codexLaunchMode: "app-server" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ codexLaunchMode: "app-server" })).resolves.toEqual({ enableMetaphor: false, codexLaunchMode: "app-server", kimiModel: null });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codexLaunchMode: "app-server" }),
      signal: undefined,
    });
  });

  it("rejects responses missing a required settings field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ enableMetaphor: false })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
  });

  it("loads the stored Kimi default model from the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      codexLaunchMode: "app-server",
      kimiModel: { model: "k3", effort: "low" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({
      enableMetaphor: false,
      codexLaunchMode: "app-server",
      kimiModel: { model: "k3", effort: "low" },
    });
  });

  it("saves the Kimi default model to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      enableMetaphor: false,
      codexLaunchMode: "app-server",
      kimiModel: { model: "k3[1m]", effort: "high" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ kimiModel: { model: "k3[1m]", effort: "high" } })).resolves.toEqual({
      enableMetaphor: false,
      codexLaunchMode: "app-server",
      kimiModel: { model: "k3[1m]", effort: "high" },
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kimiModel: { model: "k3[1m]", effort: "high" } }),
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
