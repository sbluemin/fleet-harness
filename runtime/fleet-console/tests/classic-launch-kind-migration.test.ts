import { describe, expect, it } from "vitest";

import {
  CLASSIC_LAUNCH_KIND_ID,
  GATEWAY_LAUNCH_KIND_ID,
  migrateClassicLaunchKinds,
} from "../core/host/classic-launch-kind-migration.js";
import type { DurableConsoleState, DurableDeletionTombstone } from "../core/host/durable-state.js";
import type { OperationNode } from "../core/host/operations/operations-domain.js";

function makeOperation(id: string, payload: Record<string, unknown>): OperationNode {
  return {
    id,
    theaterId: "theater-1",
    type: "agent",
    pluginId: "terminal",
    title: id,
    payload,
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

function makeState(
  operations: readonly OperationNode[],
  deletionTombstones?: readonly DurableDeletionTombstone[],
): DurableConsoleState {
  return {
    version: 3,
    theaters: [],
    operations,
    groups: [],
    ...(deletionTombstones ? { deletionTombstones } : {}),
  };
}

describe("migrateClassicLaunchKinds", () => {
  it("moves both the display and execution axes off the retired Classic id", () => {
    const state = makeState([
      makeOperation("op-1", { cwd: "/tmp", launchKindId: CLASSIC_LAUNCH_KIND_ID, cliId: CLASSIC_LAUNCH_KIND_ID }),
    ]);

    const result = migrateClassicLaunchKinds(state);

    expect(result.changed).toBe(true);
    expect(result.migratedOperations).toBe(1);
    expect(result.state.operations[0]?.payload).toEqual({
      cwd: "/tmp",
      launchKindId: GATEWAY_LAUNCH_KIND_ID,
      cliId: GATEWAY_LAUNCH_KIND_ID,
    });
  });

  it("migrates an operation that carries only the legacy cliId", () => {
    const state = makeState([makeOperation("op-1", { cliId: CLASSIC_LAUNCH_KIND_ID })]);

    const result = migrateClassicLaunchKinds(state);

    expect(result.state.operations[0]?.payload).toEqual({ cliId: GATEWAY_LAUNCH_KIND_ID });
    expect(result.state.operations[0]?.payload.launchKindId).toBeUndefined();
  });

  it("leaves neighbouring launch kinds untouched — exact match only, never a prefix", () => {
    const state = makeState([
      makeOperation("native", { launchKindId: "claude-native", cliId: "claude-native" }),
      makeOperation("gateway", { launchKindId: GATEWAY_LAUNCH_KIND_ID, cliId: GATEWAY_LAUNCH_KIND_ID }),
    ]);

    const result = migrateClassicLaunchKinds(state);

    expect(result.changed).toBe(false);
    expect(result.migratedOperations).toBe(0);
    expect(result.state).toBe(state);
  });

  it("migrates the operation embedded in an operation tombstone", () => {
    const tombstone: DurableDeletionTombstone = {
      deletionId: "del-1",
      targetId: "op-1",
      deletedAt: 1,
      expiresAt: 2,
      kind: "operation",
      operation: makeOperation("op-1", { launchKindId: CLASSIC_LAUNCH_KIND_ID }),
    };

    const result = migrateClassicLaunchKinds(makeState([], [tombstone]));

    expect(result.changed).toBe(true);
    expect(result.migratedOperations).toBe(1);
    const migrated = result.state.deletionTombstones?.[0];
    expect(migrated?.kind).toBe("operation");
    expect(migrated?.kind === "operation" ? migrated.operation.payload.launchKindId : undefined).toBe(GATEWAY_LAUNCH_KIND_ID);
  });

  it("migrates every operation embedded in a theater tombstone", () => {
    const tombstone: DurableDeletionTombstone = {
      deletionId: "del-1",
      targetId: "theater-1",
      deletedAt: 1,
      expiresAt: 2,
      kind: "theater",
      theater: {
        id: "theater-1",
        path: "/tmp",
        realpath: "/tmp",
        label: "tmp",
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      },
      operations: [
        makeOperation("op-1", { cliId: CLASSIC_LAUNCH_KIND_ID }),
        makeOperation("op-2", { cliId: "claude-native" }),
      ],
      groups: [],
    };

    const result = migrateClassicLaunchKinds(makeState([], [tombstone]));

    expect(result.migratedOperations).toBe(1);
    const migrated = result.state.deletionTombstones?.[0];
    const operations = migrated?.kind === "theater" ? migrated.operations : [];
    expect(operations[0]?.payload.cliId).toBe(GATEWAY_LAUNCH_KIND_ID);
    expect(operations[1]?.payload.cliId).toBe("claude-native");
  });

  it("is idempotent — a second pass reports no change so boot stops rewriting the file", () => {
    const first = migrateClassicLaunchKinds(
      makeState([makeOperation("op-1", { launchKindId: CLASSIC_LAUNCH_KIND_ID, cliId: CLASSIC_LAUNCH_KIND_ID })]),
    );

    const second = migrateClassicLaunchKinds(first.state);

    expect(second.changed).toBe(false);
    expect(second.migratedOperations).toBe(0);
    expect(second.state).toBe(first.state);
  });

  it("keeps the state reference identical when nothing matches", () => {
    const state = makeState([makeOperation("op-1", { cwd: "/tmp" })]);

    expect(migrateClassicLaunchKinds(state).state).toBe(state);
  });
});
