import { describe, expect, it, vi } from "vitest";

import { createDeferredDeletionCoordinator, DeferredDeletionError } from "../core/host/deferred-deletion.js";
import type { DurableDeletionTombstone } from "../core/host/durable-state.js";
import { createOperationStore } from "../core/host/operations/store.js";
import { TheaterRegistry, type TheaterRegistration } from "../core/host/theaters.js";
import { createWorkspacePresetStore } from "../core/host/workspace-presets/store.js";

const THEATER: TheaterRegistration = {
  id: "theater",
  path: "/work/theater",
  realpath: "/work/theater",
  label: "theater",
  registeredAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
};

describe("deferred deletion coordinator", () => {
  it("returns the same receipt for repeated deletion and blocks recreation during grace", () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op"));

    const first = harness.coordinator.deleteOperation("op");
    const repeated = harness.coordinator.deleteOperation("op");

    expect(repeated).toEqual(first);
    expect(harness.coordinator.hasPendingOperation("op")).toBe(true);
    expect(harness.events.filter((event) => event.channel === "operation:deleted")).toHaveLength(1);
  });

  it("restores a Theater together with its Operations and groups", async () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op-a"));
    harness.operations.create(makeOperation("op-b"));
    harness.operations.createGroup({ id: "group-a", theaterId: THEATER.id, name: "Alpha", color: "blue" });
    const preset = harness.workspacePresets.create(THEATER.id, "Review", makeWorkspacePresetLayout());
    const deletion = harness.coordinator.deleteTheater(THEATER.id);
    if (!deletion) throw new Error("expected deletion");
    expect(harness.workspacePresets.list(THEATER.id)).toEqual([]);
    expect(harness.coordinator.list()).toEqual([
      expect.objectContaining({ kind: "theater", workspacePresets: [preset] }),
    ]);

    const restored = await harness.coordinator.restore(deletion.deletionId);

    expect(restored).toEqual({ ok: true, kind: "theater", targetId: THEATER.id });
    expect(harness.theaters.get(THEATER.id)).toEqual(THEATER);
    expect(harness.operations.listByTheater(THEATER.id).map((operation) => operation.id)).toEqual(["op-a", "op-b"]);
    expect(harness.operations.listGroups(THEATER.id).map((group) => group.id)).toEqual(["group-a"]);
    expect(harness.workspacePresets.list(THEATER.id)).toEqual([preset]);
    expect(harness.events.filter((event) => event.channel === "operation:restored")).toHaveLength(2);
  });

  it("purges Theater presets with the expired tombstone", () => {
    const harness = createHarness();
    harness.workspacePresets.create(THEATER.id, "Review", makeWorkspacePresetLayout());
    const deletion = harness.coordinator.deleteTheater(THEATER.id);
    if (!deletion) throw new Error("expected deletion");
    harness.clock.value = deletion.expiresAt;

    harness.coordinator.sweepExpired();

    expect(harness.workspacePresets.list()).toEqual([]);
    expect(harness.coordinator.list()).toEqual([]);
  });

  it("rolls memory back when the durable save fails", () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op"));
    harness.failSave.value = true;

    expect(() => harness.coordinator.deleteOperation("op")).toThrow("save_failed");
    expect(harness.operations.get("op")).not.toBeNull();
    expect(harness.coordinator.list()).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects restore after expiry and purges on a startup sweep", async () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op"));
    const deletion = harness.coordinator.deleteOperation("op");
    if (!deletion) throw new Error("expected deletion");
    harness.clock.value = deletion.expiresAt;

    await expect(harness.coordinator.restore(deletion.deletionId)).rejects.toMatchObject({ status: 404 } satisfies Partial<DeferredDeletionError>);
    expect(harness.coordinator.list()).toEqual([]);
    expect(harness.events.some((event) => event.channel === "operation:purged")).toBe(true);

    const startup = createHarness();
    startup.clock.value = 10_000;
    startup.coordinator.load([makeExpiredTombstone()]);
    startup.coordinator.sweepExpired();
    expect(startup.coordinator.list()).toEqual([]);
    expect(startup.events).toEqual([expect.objectContaining({ channel: "operation:purged" })]);
  });
});

function createHarness() {
  const clock = { value: 1_000 };
  const failSave = { value: false };
  const operations = createOperationStore({ now: () => clock.value });
  const theaters = new TheaterRegistry();
  theaters.restore([THEATER]);
  const workspacePresets = createWorkspacePresetStore({ now: () => clock.value, randomId: () => `preset-${clock.value}` });
  const events: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const coordinator = createDeferredDeletionCoordinator({
    operations,
    theaters,
    workspacePresets,
    now: () => clock.value,
    randomId: () => `deletion-${clock.value}`,
    save: () => {
      if (failSave.value) throw new Error("save_failed");
    },
    publish: (channel, payload) => events.push({ channel, payload }),
    unregisterTheaterWorkspaces: vi.fn(),
    validateTheaterRestore: async () => {},
    registerTheaterWorkspace: async () => {},
    setTimer: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  return { clock, coordinator, events, failSave, operations, theaters, workspacePresets };
}

function makeOperation(id: string) {
  return {
    id,
    theaterId: THEATER.id,
    type: "agent",
    pluginId: "terminal",
    title: id,
    payload: { cwd: THEATER.path },
    geometry: null,
  };
}

function makeExpiredTombstone(): DurableDeletionTombstone {
  return {
    deletionId: "expired",
    targetId: "expired-op",
    deletedAt: 1,
    expiresAt: 2,
    kind: "operation",
    operation: {
      ...makeOperation("expired-op"),
      ts: { createdAt: 1, updatedAt: 1 },
    },
  };
}

function makeWorkspacePresetLayout() {
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    operationGeometries: {},
    minimizedOperationIds: [],
    rail: { activePanelId: null, chromeExpanded: true, panelWidth: null },
    sidebar: { statusAxis: "group" as const },
  };
}
