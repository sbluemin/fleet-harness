import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSystemPromptSettings, saveSystemPromptSettings } from "../client/system-prompt/settings-api.js";

describe("system prompt settings api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads Terminal prompt settings from the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ replaceSystemPrompt: true, enableMetaphor: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({ replaceSystemPrompt: true, enableMetaphor: false });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  it("saves exactly the two prompt booleans to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ replaceSystemPrompt: false, enableMetaphor: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ replaceSystemPrompt: false, enableMetaphor: true })).resolves.toEqual({ replaceSystemPrompt: false, enableMetaphor: true });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replaceSystemPrompt: false, enableMetaphor: true }),
      signal: undefined,
    });
  });

  it("rejects responses with fields outside the two-boolean DTO", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ replaceSystemPrompt: true, consolePortMode: "dynamic" })));
    await expect(fetchSystemPromptSettings()).rejects.toThrow("Invalid Terminal settings response");
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
