import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { Terminal } from "../client/src/components/terminal.js";
import { Operations } from "../client/src/pages/operations.js";
import type { ConsoleState } from "../client/src/types.js";

const BASE_STATE: ConsoleState = {
  connection: "live",
  connectionError: null,
  activeTheme: "maritime",
  terminalRenderer: "webgl",
  version: "1.8.0",
  updateAvailable: false,
  latestVersion: null,
  tenants: [],
  theaters: [{ id: "theater-a", label: "Alpha", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 1 }],
  agentClis: [],
  activeTheaterId: "theater-a",
  addingTheater: false,
  theaterError: null,
  sessions: {
    "session-a": {
      sessionId: "session-a",
      terminalSessionId: "session-a",
      cwdLabel: "alpha",
      sequence: 1,
      status: "registered",
      createdAt: 1,
      theaterId: "theater-a",
      resumeAvailable: true,
    },
  },
  sessionOrder: ["session-a"],
  activeTerminalSessionId: "session-a",
  operationsViewActive: true,
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
  bootstrapped: true,
  terminalSessionsHydrated: true,
  pendingOperationFocus: null,
  selectedJobId: null,
  expandedSessionIds: [],
  operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
};

describe("Operations page", () => {
  it("does not remove sessions locally from terminal close callbacks", () => {
    const terminal = findElementByType(Operations({ state: BASE_STATE }), Terminal);

    expect(terminal).toBeDefined();
    expect(terminal?.props).not.toHaveProperty("onExit");
  });
});

function findElementByType(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  for (const child of Children.toArray(node.props.children)) {
    const found = findElementByType(child, type);
    if (found) return found;
  }
  return null;
}
