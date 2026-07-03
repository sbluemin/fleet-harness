import { describe, it, expect, vi } from "vitest";

import { createBenchStore } from "../server/bench-store.js";
import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";

function makeStorage(initial: unknown = null): { storage: FleetPluginStorageHost; written: unknown[] } {
  const written: unknown[] = [];
  let current = initial;
  const storage: FleetPluginStorageHost = {
    readJson: async () => current,
    writeJson: async (_pid, _key, value) => {
      written.push(value);
      current = value;
    },
  };
  return { storage, written };
}

describe("bench-store", () => {
  it("loadRuns returns empty array when no data", async () => {
    const { storage } = makeStorage(null);
    const store = createBenchStore(storage);
    expect(await store.loadRuns()).toEqual([]);
  });

  it("saveRun persists a run and loadRuns returns it", async () => {
    const { storage } = makeStorage(null);
    const store = createBenchStore(storage);
    const now = new Date().toISOString();
    const run = {
      runId: "r1",
      theaterId: "t1",
      benchOpId: "b1",
      groupId: "g1",
      initialPrompt: "hello",
      rubric: [{ id: "c", label: "Correctness" }],
      participants: [{ cliId: "claude", opId: "op1" }],
      verdicts: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.saveRun(run);
    const loaded = await store.loadRuns();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe("r1");
  });

  it("deleteRun removes the run", async () => {
    const { storage } = makeStorage(null);
    const store = createBenchStore(storage);
    const now = new Date().toISOString();
    const run = { runId: "r1", theaterId: "t1", benchOpId: "b1", groupId: "g1", initialPrompt: "x", rubric: [], participants: [], verdicts: [], createdAt: now, updatedAt: now };
    await store.saveRun(run);
    await store.deleteRun("r1");
    expect(await store.loadRuns()).toHaveLength(0);
  });

  it("saveVerdicts updates verdicts and judgedAt", async () => {
    const { storage } = makeStorage(null);
    const store = createBenchStore(storage);
    const now = new Date().toISOString();
    const run = { runId: "r1", theaterId: "t1", benchOpId: "b1", groupId: "g1", initialPrompt: "x", rubric: [{ id: "c", label: "C" }], participants: [], verdicts: [], createdAt: now, updatedAt: now };
    await store.saveRun(run);
    const verdicts = [{ rubricId: "c", winnerOpId: "op1" }];
    const updated = await store.saveVerdicts("r1", verdicts);
    expect(updated).not.toBeNull();
    expect(updated!.verdicts).toEqual(verdicts);
    expect(updated!.judgedAt).toBeDefined();
  });

  it("saveVerdicts returns null for unknown runId", async () => {
    const { storage } = makeStorage(null);
    const store = createBenchStore(storage);
    const result = await store.saveVerdicts("unknown", []);
    expect(result).toBeNull();
  });
});
