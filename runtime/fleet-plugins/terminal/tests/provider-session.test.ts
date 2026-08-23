import { describe, expect, it } from "vitest";

import { readProviderSession } from "../server/agent-api/provider-session.js";

describe("readProviderSession", () => {
  it("omits an empty transcriptPath instead of passing it through", () => {
    expect(readProviderSession({
      session: {
        harness: "claude-code",
        id: "provider-session",
        capturedAt: "2026-06-16T00:00:00.000Z",
        transcriptPath: "",
      },
    })).toEqual({
      harness: "claude-code",
      id: "provider-session",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });
  });

  it("rejects array session values", () => {
    expect(readProviderSession({ session: [] })).toBeUndefined();
  });
});
