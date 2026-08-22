import { describe, expect, it } from "vitest";

import {
  findTheaterShellId,
  isTheaterShellLaunch,
  resolveTheaterShellLaunch,
  theaterShellDecisionRequiresHydration,
} from "../core/client/src/theater.js";
import type { OperationNode } from "../core/client/src/types.js";

const THEATER = "theater-a";
const OTHER = "theater-b";
const PLUGIN = "terminal";

describe("theater Shell singleton", () => {
  it("treats only shell launch kinds as the Theater singleton", () => {
    expect(isTheaterShellLaunch({ type: "shell" })).toBe(true);
    expect(isTheaterShellLaunch({ type: "agent" })).toBe(false);
  });

  it("does not treat an empty unhydrated list as proof that the Theater has no Shell", () => {
    expect(theaterShellDecisionRequiresHydration({ type: "shell" }, false)).toBe(true);
    expect(theaterShellDecisionRequiresHydration({ type: "shell" }, true)).toBe(false);
    expect(theaterShellDecisionRequiresHydration({ type: "agent" }, false)).toBe(false);
  });

  it("returns null when the Theater has no Shell", () => {
    expect(findTheaterShellId([
      operation("agent-1", { type: "agent" }),
      operation("shell-other", { theaterId: OTHER }),
    ], THEATER, { pluginId: PLUGIN })).toBeNull();
  });

  it("returns the Theater Shell and ignores other Theaters, types, and plugins", () => {
    expect(findTheaterShellId([
      operation("shell-a"),
      operation("shell-other", { theaterId: OTHER, ts: later(2) }),
      operation("agent-a", { type: "agent", ts: later(3) }),
      operation("foreign-shell", { pluginId: "other", ts: later(4) }),
    ], THEATER, { pluginId: PLUGIN })).toBe("shell-a");
  });

  it("prefers the active Shell when several already exist", () => {
    expect(findTheaterShellId([
      operation("older", { ts: later(1) }),
      operation("newer", { ts: later(5) }),
    ], THEATER, { pluginId: PLUGIN, activeOperationId: "older" })).toBe("older");
  });

  it("picks the most recently updated Shell when none of them is active", () => {
    expect(findTheaterShellId([
      operation("stale", { ts: { createdAt: 8, updatedAt: 2 } }),
      operation("fresh", { ts: { createdAt: 1, updatedAt: 9 } }),
    ], THEATER, { pluginId: PLUGIN, activeOperationId: "agent-elsewhere" })).toBe("fresh");
  });

  it("breaks equal update times with createdAt, then id", () => {
    expect(findTheaterShellId([
      operation("a", { ts: { createdAt: 1, updatedAt: 4 } }),
      operation("b", { ts: { createdAt: 3, updatedAt: 4 } }),
    ], THEATER, { pluginId: PLUGIN })).toBe("b");
    expect(findTheaterShellId([
      operation("m", { ts: { createdAt: 2, updatedAt: 4 } }),
      operation("z", { ts: { createdAt: 2, updatedAt: 4 } }),
    ], THEATER, { pluginId: PLUGIN })).toBe("z");
  });

  it("reuses an existing Shell instead of creating another", () => {
    expect(resolveTheaterShellLaunch(
      [operation("shell-a")],
      THEATER,
      PLUGIN,
      { type: "shell" },
    )).toEqual({ action: "reuse", operationId: "shell-a" });
  });

  it("creates when the Theater has no Shell and is not mid-launch", () => {
    expect(resolveTheaterShellLaunch([], THEATER, PLUGIN, { type: "shell" })).toEqual({ action: "create" });
    expect(resolveTheaterShellLaunch([], THEATER, PLUGIN, { type: "agent" })).toEqual({ action: "create" });
  });

  it("drops an overlapping Shell create while one is already in flight", () => {
    expect(resolveTheaterShellLaunch([], THEATER, PLUGIN, { type: "shell" }, {
      inflightTheaterIds: new Set([THEATER]),
    })).toEqual({ action: "busy" });
  });

  it("does not let an in-flight Shell block an agent launch in the same Theater", () => {
    expect(resolveTheaterShellLaunch([], THEATER, PLUGIN, { type: "agent" }, {
      inflightTheaterIds: new Set([THEATER]),
    })).toEqual({ action: "create" });
  });
});

function operation(id: string, overrides: Partial<OperationNode> = {}): OperationNode {
  return {
    id,
    theaterId: THEATER,
    type: "shell",
    pluginId: PLUGIN,
    title: "Shell",
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
    ...overrides,
  };
}

function later(at: number): OperationNode["ts"] {
  return { createdAt: at, updatedAt: at };
}
