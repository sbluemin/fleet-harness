import { describe, expect, it } from "vitest";

import { readProviderSession } from "../server/agent-api/provider-session.js";

describe("readProviderSession", () => {
  it("omits an empty transcriptPath instead of passing it through", () => {
    expect(readProviderSession({
      providerSession: {
        provider: "claude",
        sessionId: "provider-session",
        capturedAt: "2026-06-16T00:00:00.000Z",
        transcriptPath: "",
      },
    })).toEqual({
      provider: "claude",
      sessionId: "provider-session",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });
  });

  it("rejects array providerSession values", () => {
    expect(readProviderSession({ providerSession: [] })).toBeUndefined();
  });
});
