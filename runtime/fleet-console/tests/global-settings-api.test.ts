import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../core/client/src/api.js";
import { fetchGlobalSettingsState, updateGlobalSettings } from "../core/client/src/global-settings-api.js";

const originalFetch = globalThis.fetch;
const SETTINGS = { consolePortMode: "dynamic", consoleStaticPort: null, theme: "maritime", uiFont: { source: "builtin", id: "manrope", size: 14 }, language: "auto" } as const;

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

  it("normalizes malformed UI font responses to the atomic default", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...SETTINGS, uiFont: { source: "system", familyName: "\u0000", size: 99 } }))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).resolves.toEqual(SETTINGS);
  });

  it("sends the complete UI font object in one settings update", async () => {
    const uiFont = { source: "system" as const, familyName: "Noto Sans", size: 18 };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: { ...SETTINGS, uiFont } })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(updateGlobalSettings({ uiFont })).resolves.toEqual({ state: { ...SETTINGS, uiFont } });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({ body: JSON.stringify({ uiFont }) }));
  });
});
