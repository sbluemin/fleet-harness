import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENCODE_AUTH_PROVIDER_ID, OPENCODE_GO_API_BASE_URL, OPENCODE_GO_MODEL, validateOpencodeGoAuthKey } from "@fleet-console/ai-gateway";

afterEach(() => {
  vi.unstubAllGlobals();
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
