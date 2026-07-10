import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../core/client/src/api.js";
import { fetchGlobalSettingsState, updateGlobalSettings } from "../core/client/src/global-settings-api.js";

const originalFetch = globalThis.fetch;
const SETTINGS = { consolePortMode: "dynamic", consoleStaticPort: null, theme: "maritime", language: "auto" } as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("global settings client transport", () => {
  it("requires and preserves the server language preference", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(SETTINGS))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).resolves.toEqual(SETTINGS);
  });

  it("sends language through the existing partial PUT transport", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: { ...SETTINGS, language: "ko" } })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(updateGlobalSettings({ language: "ko" })).resolves.toEqual({ state: { ...SETTINGS, language: "ko" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ language: "ko" }),
    }));
  });

  it("rejects missing or invalid language values", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...SETTINGS, language: "ja" }))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).rejects.toBeInstanceOf(ApiError);
  });
});
