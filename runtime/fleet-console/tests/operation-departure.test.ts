import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDeparture,
  getDepartureIds,
  markDeparture,
  resetDepartureForTests,
  subscribeDeparture,
} from "../core/client/src/operation-departure.js";
import {
  resetSideBarStatusRecencyForTests,
  trackOperationActivityTransitions,
} from "../core/client/src/sidebar/operations-side-bar-store.js";
import type { OperationNode } from "../core/client/src/types.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  resetSideBarStatusRecencyForTests();
});

afterEach(() => {
  resetSideBarStatusRecencyForTests();
  vi.useRealTimers();
});

describe("operation departure ledger", () => {
  it("lazily expires departures after 30 seconds without weakening the 60 second cooldown", () => {
    markDeparture("operation");
    expect([...getDepartureIds()]).toEqual(["operation"]);

    vi.advanceTimersByTime(30_000);
    expect([...getDepartureIds()]).toEqual([]);

    markDeparture("operation");
    expect([...getDepartureIds()]).toEqual([]);

    vi.advanceTimersByTime(30_000);
    markDeparture("operation");
    expect([...getDepartureIds()]).toEqual(["operation"]);
  });

  it("notifies subscribers with an empty ledger when the expiry timer fires", () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeDeparture(() => {
      snapshots.push([...getDepartureIds()]);
    });

    markDeparture("operation");
    expect(snapshots).toEqual([["operation"]]);

    vi.advanceTimersByTime(29_999);
    expect(snapshots).toEqual([["operation"]]);

    vi.advanceTimersByTime(1);
    expect(snapshots).toEqual([["operation"], []]);
    unsubscribe();
  });

  it("keeps one timer on the earliest expiry and safely reschedules after each sweep", () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeDeparture(() => {
      snapshots.push([...getDepartureIds()]);
    });

    markDeparture("first");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    markDeparture("second");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(20_000);
    expect(snapshots.at(-1)).toEqual(["second"]);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(10_000);
    expect(snapshots.at(-1)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("keeps cooldown history after an active departure is cleared", () => {
    markDeparture("operation");
    clearDeparture("operation");
    vi.advanceTimersByTime(59_999);

    markDeparture("operation");
    expect([...getDepartureIds()]).toEqual([]);

    vi.advanceTimersByTime(1);
    markDeparture("operation");
    expect([...getDepartureIds()]).toEqual(["operation"]);
  });

  it("marks an unseen running transition and clears it on a later non-running transition", () => {
    const operation = makeOperation("operation", "theater-a");
    track(operation, "idle");
    track(operation, "running");
    expect([...getDepartureIds()]).toEqual([operation.id]);

    track(operation, "idle");
    expect([...getDepartureIds()]).toEqual([]);
  });

  it("skips the acknowledged active Operation in the active Theater", () => {
    const operation = makeOperation("focused", "theater-a");
    track(operation, "idle", {
      activeTheaterId: operation.theaterId,
      activeOperationId: operation.id,
      activeOperationAcknowledged: true,
    });
    track(operation, "running", {
      activeTheaterId: operation.theaterId,
      activeOperationId: operation.id,
      activeOperationAcknowledged: true,
    });

    expect([...getDepartureIds()]).toEqual([]);
  });

  it("does not skip a matching Operation when its active Theater differs", () => {
    const operation = makeOperation("focused", "theater-a");
    track(operation, "idle");
    track(operation, "running", {
      activeTheaterId: "theater-b",
      activeOperationId: operation.id,
      activeOperationAcknowledged: true,
    });

    expect([...getDepartureIds()]).toEqual([operation.id]);
  });
});

function track(
  operation: OperationNode,
  status: "idle" | "running",
  active: {
    readonly activeTheaterId: string | null;
    readonly activeOperationId: string | null;
    readonly activeOperationAcknowledged: boolean;
  } = {
    activeTheaterId: null,
    activeOperationId: null,
    activeOperationAcknowledged: true,
  },
): void {
  trackOperationActivityTransitions({
    operations: [operation],
    operationStatus: { [operation.id]: status },
    ...active,
  });
}

function makeOperation(id: string, theaterId: string): OperationNode {
  return {
    id,
    theaterId,
    type: "test",
    pluginId: "test",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
