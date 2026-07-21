// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { commandBandActiveOperation, commandBandRenameCommitTarget } from "../core/client/src/components/command-band-guards.js";
import type { OperationNode } from "../core/client/src/types.js";

describe("Command Band v2 guards", () => {
  it("does not commit a previous Operation draft after another panel becomes active", () => {
    const draft = "previous-operation draft";
    const capturedOperationId = "operation-a";
    const activeOperationId = "operation-b";

    expect(draft).toBe("previous-operation draft");
    expect(commandBandRenameCommitTarget(capturedOperationId, activeOperationId)).toBeNull();
  });
});

describe("Command Band active Operation display guard", () => {
  const operations: readonly OperationNode[] = [
    makeOperation("op-a", "theater-a"),
    makeOperation("op-b", "theater-b"),
  ];

  it("returns the active Operation when it belongs to the active Theater", () => {
    expect(commandBandActiveOperation(operations, "op-a", "theater-a")?.id).toBe("op-a");
  });

  it("hides a stale Operation after switching to another Theater", () => {
    // setActiveTheater는 activeOperationId를 지우지 않는다 — 타 Theater op는 표시하지 않는다.
    expect(commandBandActiveOperation(operations, "op-b", "theater-a")).toBeNull();
  });

  it("returns null without an active Theater or Operation", () => {
    expect(commandBandActiveOperation(operations, null, "theater-a")).toBeNull();
    expect(commandBandActiveOperation(operations, "op-a", null)).toBeNull();
    expect(commandBandActiveOperation(operations, "op-gone", "theater-a")).toBeNull();
  });
});

function makeOperation(id: string, theaterId: string): OperationNode {
  return {
    id,
    theaterId,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
