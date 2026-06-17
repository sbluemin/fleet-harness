import { describe, expect, it } from "vitest";

import { sessionDisplayLabel } from "../client/src/format.js";
import type { SessionInfo } from "../client/src/types.js";

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: "session-a",
    terminalSessionId: "session-a",
    cwdLabel: "alpha",
    sequence: 1,
    status: "terminal-only",
    turnState: "none",
    createdAt: 1,
    resumeAvailable: false,
    ...overrides,
  };
}

describe("sessionDisplayLabel", () => {
  it("defaults to the per-Theater sequence as '#N Operation'", () => {
    expect(sessionDisplayLabel(makeSession({ sequence: 1 }))).toBe("#1 Operation");
    expect(sessionDisplayLabel(makeSession({ sequence: 7 }))).toBe("#7 Operation");
  });

  it("prefers a non-empty user-set label over the sequence default", () => {
    expect(sessionDisplayLabel(makeSession({ sequence: 2, label: "Bridge" }))).toBe("Bridge");
  });

  it("falls back to the sequence default when the label is blank", () => {
    expect(sessionDisplayLabel(makeSession({ sequence: 3, label: "   " }))).toBe("#3 Operation");
  });
});
