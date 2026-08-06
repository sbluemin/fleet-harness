import { describe, expect, it, vi } from "vitest";

import { OPENCODE_AUTH_PROVIDER_ID } from "../../src/opencode-go/index.js";
import { fetchOpencodeUsage } from "../../src/opencode-go/quota.js";

describe("OpenCode Go quota", () => {
  it("reads its key through the injected auth service without constructing a default auth path", async () => {
    const authService = {
      getApiKey: vi.fn(async (providerId: string) => providerId === OPENCODE_AUTH_PROVIDER_ID ? "opencode-key" : undefined),
      setApiKey: async () => undefined,
      deleteApiKey: async () => false,
      listProviderIds: async () => [],
    };
    const result = await fetchOpencodeUsage({
      authService,
      scanOpencodeGoWindows: async () => null,
      now: () => 42,
    });
    expect(result).toEqual({ status: "ok", plan: "Go", windows: [], fetchedAt: 42 });
    expect(authService.getApiKey).toHaveBeenCalledWith(OPENCODE_AUTH_PROVIDER_ID);
  });
});
