import { describe, expect, it } from "vitest";

import { buildOperationSearchEntries, filterOperationSearchEntries, groupOperationSearchEntries } from "../client/src/operation-search.js";
import type { ConsoleState, SessionInfo, TheaterInfo } from "../client/src/types.js";

const THEATER_ALPHA: TheaterInfo = { id: "theater-alpha", label: "Alpha Harbor", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: true, activeAdmiralCount: 1 };
const THEATER_BETA: TheaterInfo = { id: "theater-beta", label: "Beta Dock", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
const THEATER_GAMMA: TheaterInfo = { id: "theater-gamma", label: "Alpha Harbor", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };

function makeState(sessions: readonly (Omit<SessionInfo, "resumeAvailable" | "turnState"> & { readonly resumeAvailable?: boolean; readonly turnState?: SessionInfo["turnState"] })[], theaters: readonly TheaterInfo[] = [THEATER_ALPHA, THEATER_BETA]): ConsoleState {
  const entries: SessionInfo[] = sessions.map((session) => ({ ...session, resumeAvailable: session.resumeAvailable ?? false, turnState: session.turnState ?? "none" }));
  return {
    operationToasts: [],
    connection: "connecting",
    connectionError: null,
    activeTheme: "maritime",
    terminalRenderer: "webgl",
    version: "1.8.0",
    updateAvailable: false,
    latestVersion: null,
    tenants: [],
    theaters,
    agentClis: [],
    activeTheaterId: "theater-alpha",
    addingTheater: false,
    theaterError: null,
    sessions: Object.fromEntries(entries.map((session) => [session.sessionId, session])),
    sessionOrder: entries.map((session) => session.sessionId),
    activeTerminalSessionId: null,
    operationsViewActive: false,
    creatingTerminalSession: false,
    terminalSessionError: null,
    tenantJobs: {},
    tenantOrder: [],
    timelineOpen: false,
    shellOpen: false,
    operationSearchOpen: false,
    shortcutsOpen: false,
    whatsNewOpen: false,
    onboardingOpen: false,
    bootstrapped: false,
    terminalSessionsHydrated: false,
    pendingOperationFocus: null,
    selectedJobId: null,
    expandedSessionIds: [],
  };
}

describe("operation search", () => {
  it("builds entries across all Theaters in session order and skips sessions without theaterId", () => {
    const entries = buildOperationSearchEntries(makeState([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "raw-alpha-path", sequence: 1, label: "Bridge Watch", cliLabel: "Codex", status: "terminal-only", createdAt: 3, theaterId: "theater-alpha" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "raw-beta-path", sequence: 2, status: "registered", createdAt: 2, theaterId: "theater-beta" },
      { sessionId: "session-c", terminalSessionId: "session-c", cwdLabel: "raw-floating-path", sequence: 3, status: "starting", createdAt: 1 },
      { sessionId: "session-d", terminalSessionId: "session-d", cwdLabel: "raw-race-path", sequence: 4, status: "live", createdAt: 0, theaterId: "theater-race" },
    ]));

    expect(entries.map((entry) => [entry.sessionId, entry.theaterLabel, entry.operationName, entry.cliLabel])).toEqual([
      ["session-a", "Alpha Harbor", "Bridge Watch", "Codex"],
      ["session-b", "Beta Dock", "#2 Operation", undefined],
      ["session-d", "theater-race", "#4 Operation", undefined],
    ]);
  });

  it("matches case-insensitive AND tokens across operation, Theater, and CLI labels", () => {
    const entries = buildOperationSearchEntries(makeState([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge Watch", cliLabel: "Codex", status: "terminal-only", createdAt: 3, theaterId: "theater-alpha" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Cargo Sweep", cliLabel: "Claude", status: "registered", createdAt: 2, theaterId: "theater-beta" },
    ]));

    expect(filterOperationSearchEntries(entries, "bridge codex").map((entry) => entry.sessionId)).toEqual(["session-a"]);
    expect(filterOperationSearchEntries(entries, "BETA claude").map((entry) => entry.sessionId)).toEqual(["session-b"]);
    expect(filterOperationSearchEntries(entries, "bridge claude")).toEqual([]);
    expect(filterOperationSearchEntries(entries, "")).toEqual(entries);
  });

  it("groups filtered entries by Theater id without merging duplicate labels", () => {
    const entries = buildOperationSearchEntries(makeState([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge Watch", status: "terminal-only", createdAt: 3, theaterId: "theater-alpha" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Cargo Sweep", status: "registered", createdAt: 2, theaterId: "theater-beta" },
      { sessionId: "session-c", terminalSessionId: "session-c", cwdLabel: "alpha", sequence: 3, label: "Anchor Prep", status: "live", createdAt: 1, theaterId: "theater-alpha" },
      { sessionId: "session-d", terminalSessionId: "session-d", cwdLabel: "gamma", sequence: 4, label: "Night Watch", status: "live", createdAt: 0, theaterId: "theater-gamma" },
    ], [THEATER_ALPHA, THEATER_BETA, THEATER_GAMMA]));

    expect(groupOperationSearchEntries(entries).map((group) => [group.theaterId, group.theaterLabel, group.entries.map((entry) => entry.operationName)])).toEqual([
      ["theater-alpha", "Alpha Harbor", ["Bridge Watch", "Anchor Prep"]],
      ["theater-beta", "Beta Dock", ["Cargo Sweep"]],
      ["theater-gamma", "Alpha Harbor", ["Night Watch"]],
    ]);
  });
});
