import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSystemPromptSettings, saveSystemPromptSettings } from "../client/agent/settings-api.js";

describe("system prompt settings api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads Terminal prompt settings from the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSystemPromptSettings()).resolves.toEqual({ enableMetaphor: false });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", { signal: undefined });
  });

  it("saves the prompt boolean to the plugin route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enableMetaphor: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveSystemPromptSettings({ enableMetaphor: true })).resolves.toEqual({ enableMetaphor: true });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enableMetaphor: true }),
      signal: undefined,
    });
  });

  it("rejects responses missing the enableMetaphor boolean field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ consolePortMode: "dynamic" })));
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
