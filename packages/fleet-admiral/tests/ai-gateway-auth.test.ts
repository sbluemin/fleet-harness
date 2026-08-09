import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_MODEL,
  OPENCODE_AUTH_PROVIDER_ID,
  OPENCODE_GO_API_BASE_URL,
  OPENCODE_GO_MODEL,
  validateKimiAuthKey,
  validateOpencodeGoAuthKey,
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

describe("OpenCode Go AI Gateway authentication", () => {
  it("keeps the persisted provider id stable", () => {
    expect(OPENCODE_AUTH_PROVIDER_ID).toBe("Claude Code with OpenCode Go");
    expect(OPENCODE_GO_API_BASE_URL).toBe("https://opencode.ai/zen/go");
    expect(OPENCODE_GO_MODEL).toBe("minimax-m3");
  });

  it("validates the key against the OpenCode Go messages endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateOpencodeGoAuthKey("opencode-secret")).resolves.toEqual({
      providerId: OPENCODE_AUTH_PROVIDER_ID,
      status: "success",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "opencode-secret" }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) throw new Error("Expected OpenCode Go validation request options.");
    expect(JSON.parse(String(request.body))).toMatchObject({ model: "minimax-m3", max_tokens: 1 });
  });
});
