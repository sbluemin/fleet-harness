import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_MODEL,
  validateKimiAuthKey,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kimi AI Gateway authentication", () => {
  it("keeps the persisted provider id stable", () => {
    expect(KIMI_AUTH_PROVIDER_ID).toBe("Claude Code with Moonshot Kimi");
    expect(KIMI_CODE_API_BASE_URL).toBe("https://api.kimi.com/coding");
    expect(KIMI_CODE_MODEL).toBe("k3");
  });

  it("validates the key against the Kimi coding endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateKimiAuthKey("kimi-secret")).resolves.toEqual({
      providerId: KIMI_AUTH_PROVIDER_ID,
      status: "success",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.kimi.com/coding/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "kimi-secret" }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) throw new Error("Expected Kimi validation request options.");
    expect(JSON.parse(String(request.body))).toMatchObject({ model: "k3" });
  });
});
