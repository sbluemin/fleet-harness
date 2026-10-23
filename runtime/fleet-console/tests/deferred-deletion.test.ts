import { createObjectiveStorage } from "../features/objectives/host/storage.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDeferredDeletionCoordinator, DeferredDeletionError } from "../features/workspace/host/deferred-deletion.js";
import { createTheaterSystemPromptService } from "../features/settings/host/agent-options.js";
import type { AgentOptionsData } from "@fleet-console/infra";
import { STATE_VERSION, type DurableConsoleState, type DurableDeletionTombstone } from "../features/workspace/host/durable-state.js";
import { createDurableJsonStore, type DurableJsonStore } from "@fleet-console/infra";
import { type ArchivedObjective } from "../features/workspace/host/objective-archive-storage.js";
import { createObjectiveArchiveCoordinator } from "../features/workspace/host/objective-archive.js";
import { createObjectiveArchiveRouter } from "../features/workspace/host/objective-archive-routes.js";
import { createSanitizedOpDto, createObjectiveRecordsStore, type ObjectiveRecord } from "../features/objectives/host/records/objective-records-domain.js";
import { TheaterRegistry, type TheaterRegistration } from "../features/workspace/host/theaters/theater-domain.js";

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
    harness.objectiveRecords.create(makeObjective("op"));

    const first = harness.coordinator.deleteObjective("op");
    const repeated = harness.coordinator.deleteObjective("op");

    expect(repeated).toEqual(first);
    expect(harness.coordinator.hasPendingObjective("op")).toBe(true);
    expect(harness.events.filter((event) => event.channel === "objective:deleted")).toHaveLength(1);
  });

  it("restores a Theater together with its Objectives and groups", async () => {
    const harness = createHarness();
    harness.objectiveRecords.create(makeObjective("op-a"));
    harness.objectiveRecords.create(makeObjective("op-b"));
    harness.objectiveRecords.createGroup({ id: "group-a", theaterId: THEATER.id, name: "Alpha", color: "blue" });
    const deletion = harness.coordinator.deleteTheater(THEATER.id);
    if (!deletion) throw new Error("expected deletion");

    const restored = await harness.coordinator.restore(deletion.deletionId);

    expect(restored).toEqual({ ok: true, kind: "theater", targetId: THEATER.id });
    expect(harness.theaters.get(THEATER.id)).toEqual(THEATER);
    expect(harness.objectiveRecords.listByTheater(THEATER.id).map((objectiveRecord) => objectiveRecord.id)).toEqual(["op-a", "op-b"]);
    expect(harness.objectiveRecords.listGroups(THEATER.id).map((group) => group.id)).toEqual(["group-a"]);
    expect(harness.events.filter((event) => event.channel === "objective:restored")).toHaveLength(2);
  });

  it("hides a forgotten Theater prompt, restores it during grace, and purges it after expiry", async () => {
    const harness = createHarness();
    let data: AgentOptionsData = {};
    const options = { load: () => data, update: (mutate: (current: AgentOptionsData) => AgentOptionsData) => (data = mutate(data)) };
    const prompts = createTheaterSystemPromptService(options, (id) => harness.theaters.get(id) !== null);
    prompts.save(THEATER.id, { mode: "off", body: "private instructions" });
    prompts.keepSubagents(THEATER.id, true);
    harness.beforePurge.value = (_nodes, tombstone) => { if (tombstone.kind === "theater") prompts.purge(tombstone.targetId); };
    const deletion = harness.coordinator.deleteTheater(THEATER.id)!;
    expect(prompts.read(THEATER.id)).toBeNull();
    await harness.coordinator.restore(deletion.deletionId);
    expect(prompts.read(THEATER.id)).toEqual({ mode: "off", body: "private instructions" });
    const again = harness.coordinator.deleteTheater(THEATER.id)!;
    harness.clock.value = again.expiresAt;
    harness.coordinator.sweepExpired();
    expect(data).toEqual({});
  });

  it("rolls memory back when the durable save fails", () => {
    const harness = createHarness();
    harness.objectiveRecords.create(makeObjective("op"));
    harness.failSave.value = true;

    expect(() => harness.coordinator.deleteObjective("op")).toThrow("save_failed");
    expect(harness.objectiveRecords.get("op")).not.toBeNull();
    expect(harness.coordinator.list()).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects restore after expiry and purges on a startup sweep", async () => {
    const harness = createHarness();
    harness.objectiveRecords.create(makeObjective("op"));
    const deletion = harness.coordinator.deleteObjective("op");
    if (!deletion) throw new Error("expected deletion");
    harness.clock.value = deletion.expiresAt;

    await expect(harness.coordinator.restore(deletion.deletionId)).rejects.toMatchObject({ status: 404 } satisfies Partial<DeferredDeletionError>);
    expect(harness.coordinator.list()).toEqual([]);
    expect(harness.events.some((event) => event.channel === "objective:purged")).toBe(true);

    const startup = createHarness();
    startup.clock.value = 10_000;
    startup.coordinator.load([makeExpiredTombstone()]);
    startup.coordinator.sweepExpired();
    expect(startup.coordinator.list()).toEqual([]);
    expect(startup.events).toEqual([expect.objectContaining({ channel: "objective:purged" })]);
  });
});

describe("Objective archive persistence and deletion", () => {
  // 기존 유예 삭제 시험은 두 파일 이동·자식 세션 보존·복원 경계를 거치지 않는다.
  it("parks an Objective with its child sessions and restores the complete dormant record", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      h.objectiveRecords.create({ ...makeObjective("parent"), ...({ session: { harness: "claude-code", id: "provider-session", transcriptPath: "/private/transcript" } }) });
      h.objectiveRecords.createChild({ parentObjectiveId: "parent", childSessionId: "11111111-1111-4111-8111-111111111111", ...({ session: { harness: "claude-code", sessionName: "표시용 구성원", id: "private-child-session", transcriptPath: "/private/child-transcript" } }) });
      h.save();
      await expect(h.archive.archive("11111111-1111-4111-8111-111111111111")).rejects.toThrow("child_session_not_closable");
      const receipt = await h.archive.archive("parent");
      expect(h.stopped).toEqual(["parent", "11111111-1111-4111-8111-111111111111"]);
      expect(h.objectiveRecords.list()).toEqual([]);
      expect(h.archive.describe("11111111-1111-4111-8111-111111111111")?.location).toBe("archived");
      expect(h.objectiveRecords.get("11111111-1111-4111-8111-111111111111")).toBeNull();
      expect(h.events.map((event) => event.channel)).toEqual(["objective:archived"]);
      expect(() => h.objectiveRecords.create(makeObjective("11111111-1111-4111-8111-111111111111"))).toThrow("objectiveRecord_exists");
      expect(JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).objectiveRecords).toBeUndefined();
      const saved = JSON.parse(fs.readFileSync(path.join(directory, "commodore/owner/objectives/archive.json"), "utf8"));
      expect(saved.entries[0].objective.sessions[0].session.id).toBe("private-child-session");
      expect(JSON.stringify(saved)).not.toMatch(/"(?:payload|geometry|theaterId|pluginId|userQuestions|resumeAvailable|launchKey)"\s*:/);
      const router = createObjectiveArchiveRouter({ archive: h.archive, isAuthorized: () => false,
        readJsonBody: async <T,>() => ({}) as T, sanitize: (node) => createSanitizedOpDto(node, { includeSessionNames: true }),
        writeJson: (res, status, body) => Object.assign(res, { status, body }),
      });
      const readback: { status?: number; body?: unknown } = {};
      await router({ req: { method: "GET" } as never, res: readback as never, pathname: "/api/v1/objectives/records/parent/describe" });
      expect(readback.status).toBe(200);
      expect(JSON.stringify(readback.body)).not.toMatch(/provider-session|private-child-session|\/private\//);
      expect(JSON.stringify(readback.body)).toContain("표시용 구성원");
      const denied: { status?: number } = {};
      await router({ req: { method: "POST" } as never, res: denied as never, pathname: "/api/v1/objectives/records/child/restore" });
      expect(denied.status).toBe(401);
      expect(h.objectiveRecords.get("11111111-1111-4111-8111-111111111111")).toBeNull();
      const restarted = createArchiveHarness(directory);
      expect(restarted.archive.listArchived().total).toBe(1);
      const restored = await restarted.archive.undoArchive(receipt);
      expect(restored.rootObjectiveId).toBe("parent");
      expect(restored.objectiveRecords.map((node) => node.id).sort()).toEqual(["parent"]);
      expect(restored.objectiveRecords.every((node) => node.restoredDormant === true)).toBe(true);
      expect(restarted.objectiveRecords.get("parent")?.session).toEqual({ harness: "claude-code", id: "provider-session", transcriptPath: "/private/transcript" });
      expect(restarted.objectiveRecords.get("11111111-1111-4111-8111-111111111111")?.restoredDormant).toBe(true);
      expect(restarted.objectiveRecords.list()).toHaveLength(1);
      expect(restarted.archive.listArchived().entries).toEqual([]);
      await restarted.archive.archive("parent");
      const confirm = restarted.archive.previewPurge("parent");
      await expect(restarted.archive.purge({ ...confirm, revision: confirm.revision - 1 })).rejects.toThrow("archive_revision_conflict");
      const pending = await restarted.archive.purge(confirm);
      expect(restarted.events.filter((event) => event.channel === "objective:purged")).toEqual([]);
      restarted.clock.value = pending.purgeAt;
      await restarted.archive.sweepExpired();
      expect(restarted.events.filter((event) => event.channel === "objective:purged").map((event) => event.objectiveRecord.id).sort()).toEqual(["parent"]);
      expect(createArchiveHarness(directory).archive.describe("parent")).toBeNull();
    });
  });

  // 유예 삭제는 기존 tombstone과 다르다. 새 지원 경로의 핵심은 만료 전 디스크 불변·재기동 취소·원자적인 일괄 확정이다.
  it("keeps pending batches intact on disk, cancels on undo or restart, and commits the exact batch atomically", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      h.objectiveRecords.create(makeObjective("a"));
      h.objectiveRecords.create(makeObjective("b"));
      h.objectiveRecords.createChild({ parentObjectiveId: "a", childSessionId: "11111111-1111-4111-8111-111111111111", ...({ session: { harness: "claude-code", id: "secret", sessionName: "구성원 이름" } }) });
      h.save();
      await h.archive.archive("a"); await h.archive.archive("b");
      const files = ["state.json", "commodore/owner/objectives/archive.json"].map((name) => path.join(directory, name));
      const before = files.map((file) => fs.readFileSync(file, "utf8"));
      const stale = h.archive.previewBatch(["a", "b"]);
      await expect(h.archive.purge({ ...stale, objectiveIds: ["a", "a"] })).rejects.toThrow("invalid_archive_request");
      const pending = await h.archive.purge(stale);
      expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
      expect(h.archive.listArchived().pendingPurges).toEqual([expect.objectContaining({ objectiveIds: ["a", "b"], purgeId: pending.purgeId })]);
      await expect(h.archive.restore("a")).rejects.toThrow("pending_deletion");
      expect(() => h.deletion.deleteTheater(THEATER.id)).toThrow("objectiveRecord_busy");
      await expect(h.archive.purge(stale)).rejects.toThrow("archive_revision_conflict");
      await h.archive.undoPurge(pending.purgeId);
      h.clock.value = pending.purgeAt;
      await h.archive.sweepExpired();
      expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
      const abandoned = await h.archive.purge(h.archive.previewBatch(["a", "b"]));
      h.archive.dispose(); // 종료와 크래시 모두 메모리 보류를 잃고 디스크 원본만 읽는다.
      const restarted = createArchiveHarness(directory);
      restarted.clock.value = abandoned.purgeAt + 60_000;
      await restarted.archive.sweepExpired();
      expect(restarted.archive.listArchived().entries.map((entry) => entry.objectiveRecord.id).sort()).toEqual(["a", "b"]);
      expect(restarted.archive.listArchived().pendingPurges).toEqual([]);
      expect(restarted.archive.describe("11111111-1111-4111-8111-111111111111")?.objectiveRecord?.sessions?.[0]?.session).toEqual({ harness: "claude-code", id: "secret", sessionName: "구성원 이름" });
      await expect(restarted.archive.restoreBatch({ ...restarted.archive.previewBatch(["a", "b"]), objectiveIds: ["a", "missing"] })).rejects.toThrow("unknown_objectiveRecord");
      expect(restarted.objectiveRecords.list()).toEqual([]);
      await expect(restarted.archive.purge(stale)).rejects.toThrow("archive_revision_conflict");
      const restored = await restarted.archive.restoreBatch(restarted.archive.previewBatch(["a", "b"]));
      expect(restored.objectiveRecords.map((node) => node.id).sort()).toEqual(["a", "b"]);
      expect(restored.objectiveRecords.every((node) => node.restoredDormant === true)).toBe(true);
      expect(restored.objectiveRecords[0]?.sessions?.[0]?.restoredDormant).toBe(true);
      await restarted.archive.archive("a"); await restarted.archive.archive("b");
      const final = await restarted.archive.purge(restarted.archive.previewBatch(["a", "b"]));
      restarted.clock.value = final.purgeAt - 1;
      await restarted.archive.sweepExpired();
      expect(restarted.archive.listArchived().total).toBe(2);
      restarted.clock.value = final.purgeAt;
      await expect(restarted.archive.undoPurge(final.purgeId)).rejects.toThrow("archive_undo_conflict");
      restarted.fault.finalize = true;
      await expect(restarted.archive.sweepExpired()).rejects.toThrow("archive_finalize_failed");
      expect(restarted.events.filter((event) => event.channel === "objective:purged")).toEqual([]);
      const recovered = createArchiveHarness(directory);
      recovered.archive.flushEvents();
      expect(recovered.archive.listArchived().entries).toEqual([]);
      expect(recovered.events.filter((event) => event.channel === "objective:purged").map((event) => event.objectiveRecord.id).sort()).toEqual(["a", "b"]);
      expect(recovered.archive.describe("11111111-1111-4111-8111-111111111111")).toBeNull();
      recovered.archive.dispose(); restarted.archive.dispose();
    });
  });

  it("recovers a durable move before publishing either storage location after a crash", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      h.objectiveRecords.create(makeObjective("op")); h.save();
      h.fault.state = true;
      await expect(h.archive.archive("op")).rejects.toThrow("state_write_failed");
      expect(() => h.save()).toThrow("archive_recovery_required");
      expect(h.events).toEqual([]);
      const recovered = createArchiveHarness(directory);
      expect(recovered.objectiveRecords.get("op")).toBeNull();
      expect(recovered.archive.describe("op")?.location).toBe("archived");
      recovered.fault.finalize = true;
      await expect(recovered.archive.restore("op")).rejects.toThrow("archive_finalize_failed");
      const restored = createArchiveHarness(directory);
      expect(restored.objectiveRecords.get("op")).not.toBeNull();
      expect(restored.archive.listArchived().total).toBe(0);
      expect(restored.objectiveRecords.list()).toHaveLength(1);
    });
  });

  it("deletes archived clusters through grace and purge, preserving original locations on Theater undo", async () => {
    await withArchiveDirectory(async (directory) => {
      let h = createArchiveHarness(directory);
      h.objectiveRecords.create(makeObjective("parent"));
      h.objectiveRecords.createChild({ parentObjectiveId: "parent", childSessionId: "11111111-1111-4111-8111-111111111111" }); h.save();
      await h.archive.archive("parent");
      const theaterDeletion = h.deletion.deleteTheater(THEATER.id)!;
      expect(theaterDeletion.archivedObjectiveCount).toBe(1);
      h = createArchiveHarness(directory);
      expect(h.theaters.list()).toEqual([]);
      await h.deletion.restore(theaterDeletion.deletionId);
      expect(h.objectiveRecords.get("parent")).toBeNull();
      expect(h.objectiveRecords.get("11111111-1111-4111-8111-111111111111")).toBeNull();
      expect(h.archive.describe("11111111-1111-4111-8111-111111111111")?.location).toBe("archived");
      await h.archive.archive("parent");
      const deletion = h.deletion.deleteObjective("parent")!;
      expect(h.archive.listArchived().total).toBe(0);
      await expect(h.archive.access("11111111-1111-4111-8111-111111111111")).rejects.toThrow("pending_deletion");
      h.clock.value = deletion.expiresAt;
      h.deletion.sweepExpired();
      expect(h.purged).toEqual(["parent"]);
      const boot = createArchiveHarness(directory);
      expect(boot.archive.listArchived().total).toBe(0);
      expect(boot.deletion.list()).toEqual([]);
      expect(boot.objectiveRecords.list()).toEqual([]);
      expect(fs.readFileSync(path.join(directory, "commodore", "owner", "objectives", "archive.json"), "utf8")).not.toContain('"id": "parent"');
    });
  });

  it("refuses corrupt or conflicting stores instead of replacing them with empty state", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory); h.objectiveRecords.create(makeObjective("op")); h.save();
      await h.archive.archive("op");
      const archiveFile = path.join(directory, "commodore", "owner", "objectives", "archive.json");
      const intact = fs.readFileSync(archiveFile, "utf8");
      fs.unlinkSync(archiveFile);
      expect(() => createArchiveHarness(directory)).toThrow("archive_recovery_required");
      expect(fs.existsSync(archiveFile)).toBe(false);
      fs.writeFileSync(archiveFile, intact);
      fs.writeFileSync(archiveFile, "{broken");
      expect(() => createArchiveHarness(directory)).toThrow("archive_recovery_required");
      expect(fs.readFileSync(archiveFile, "utf8")).toBe("{broken");
    });
  });

  it("purges only expired archived roots and leaves manual undo, active, and re-archived entries", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      const day = 86_400_000;
      const start = 5_000_000_000;
      h.clock.value = start;
      h.objectiveRecords.create(makeObjective("live"));
      h.objectiveRecords.create(makeObjective("old"));
      h.objectiveRecords.createChild({ parentObjectiveId: "old", childSessionId: "11111111-1111-4111-8111-111111111111" });
      h.objectiveRecords.create(makeObjective("young"));
      h.objectiveRecords.create(makeObjective("held"));
      h.objectiveRecords.create(makeObjective("reborn"));
      h.objectiveRecords.create(makeObjective("future"));
      h.save();
      await h.archive.archive("old");
      await h.archive.archive("held");
      await h.archive.archive("reborn");
      h.clock.value = start + 30 * day - 1;
      await h.archive.archive("young");
      h.clock.value = start + 30 * day + 5_000;
      await h.archive.archive("future");
      h.clock.value = start + 30 * day;
      await h.archive.restore("reborn");
      await h.archive.archive("reborn");
      const pending = await h.archive.purge(h.archive.previewPurge("held"));
      await h.archive.sweepRetention();
      expect(h.archive.listArchived().entries.map((entry) => entry.objectiveRecord.id).sort()).toEqual(["future", "held", "old", "reborn", "young"]);

      h.retention.days = 30;
      await h.archive.sweepRetention();
      expect(h.archive.describe("old")).toBeNull();
      expect(h.archive.describe("11111111-1111-4111-8111-111111111111")).toBeNull();
      expect(h.events.filter((event) => event.channel === "objective:purged").map((event) => event.objectiveRecord.id)).toEqual(["old"]);
      expect(h.archive.listArchived().entries.map((entry) => entry.objectiveRecord.id).sort()).toEqual(["future", "held", "reborn", "young"]);
      expect(h.objectiveRecords.get("live")?.id).toBe("live");
      await h.archive.undoPurge(pending.purgeId);
      expect(h.archive.describe("held")?.location).toBe("archived");

      h.retention.days = null;
      h.clock.value += 90 * day;
      await h.archive.sweepRetention();
      expect(h.archive.describe("young")?.location).toBe("archived");
      const before = h.scheduled.length;
      await h.archive.startRetention();
      expect(h.archive.describe("young")?.location).toBe("archived");
      const armed = h.scheduled.slice(before).find((item) => item.delay === 60_000);
      expect(armed?.delay).toBe(60_000);
      h.retention.days = 30;
      armed?.run();
      await h.archive.sweepRetention();
      expect(h.archive.describe("young")).toBeNull();
      h.objectiveRecords.create(makeObjective("fresh"));
      await h.archive.archive("fresh");
      const next = h.scheduled.filter((item) => item.delay === 60_000).at(-1);
      const armedCount = h.scheduled.filter((item) => item.delay === 60_000).length;
      h.archive.dispose();
      expect(h.cleared.has(next?.handle)).toBe(true);
      next?.run();
      await h.archive.sweepRetention();
      expect(h.scheduled.filter((item) => item.delay === 60_000)).toHaveLength(armedCount);
      expect(h.archive.describe("fresh")?.location).toBe("archived");
    });
  });

  it("arms the next retention check only after the in-flight sweep, including one blocked by stop", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      const day = 86_400_000;
      h.clock.value = 5_000_000_000;
      h.objectiveRecords.create(makeObjective("blocker"));
      h.objectiveRecords.create(makeObjective("old"));
      h.save();
      await h.archive.archive("old");
      h.clock.value += 30 * day;
      h.retention.days = 30;
      let release: () => void = () => {};
      h.stopGate.current = new Promise<void>((resolve) => { release = resolve; });
      const archiving = h.archive.archive("blocker");
      await vi.waitFor(() => { expect(h.stopped).toContain("blocker"); });
      const starting = h.archive.startRetention();
      expect(h.scheduled.filter((item) => item.delay === 60_000)).toHaveLength(0);
      expect(h.archive.describe("old")?.location).toBe("archived");
      release();
      h.stopGate.current = null;
      await archiving;
      await starting;
      expect(h.archive.describe("old")).toBeNull();
      expect(h.scheduled.filter((item) => item.delay === 60_000)).toHaveLength(1);
      h.archive.dispose();
      h.scheduled.find((item) => item.delay === 60_000)?.run();
      await h.archive.sweepRetention();
      expect(h.scheduled.filter((item) => item.delay === 60_000)).toHaveLength(1);
    });
  });

  it("does not overwrite an archive journal when automatic retention fails to commit", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      const day = 86_400_000;
      h.clock.value = 5_000_000_000;
      h.objectiveRecords.create(makeObjective("old"));
      h.save();
      await h.archive.archive("old");
      h.clock.value += 30 * day;
      h.retention.days = 30;
      h.fault.finalize = true;
      await expect(h.archive.sweepRetention()).rejects.toThrow("archive_finalize_failed");
      expect(h.storage.blocked()).toBe(true);
      const journal = fs.readFileSync(path.join(directory, "commodore", "owner", "objectives", "archive.json"), "utf8");
      expect(journal).toContain("\"transaction\"");
      await expect(h.archive.sweepRetention()).rejects.toThrow("archive_recovery_required");
      expect(fs.readFileSync(path.join(directory, "commodore", "owner", "objectives", "archive.json"), "utf8")).toBe(journal);
      const recovered = createArchiveHarness(directory);
      expect(recovered.archive.describe("old")).toBeNull();
    });
  });
});

async function withArchiveDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const root = path.resolve(".fleet/isolated/archive-tests");
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  try { await run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function createArchiveHarness(directory: string) {
  const fault = { state: false, finalize: false };
  const clock = { value: 1_000 };
  const diskState = createDurableJsonStore<DurableConsoleState>({ filePath: path.join(directory, "state.json"), lockDir: null, sensitivity: "sensitive", sanitize: (value) => value as DurableConsoleState });
  const stateStore: DurableJsonStore<DurableConsoleState> = { ...diskState, save: (state) => { if (fault.state) throw new Error("state_write_failed"); diskState.save(state); } };
  const storage = createObjectiveStorage({ directory, stateStore, owners: () => [{ directory: path.join(directory, "commodore/owner/objectives"), theaterId: THEATER.id, workspacePath: directory }], createStore: ((deps: Parameters<typeof createDurableJsonStore>[0]) => {
    const store = createDurableJsonStore(deps);
    return { ...store, save: (value: unknown) => { if (fault.finalize && deps.filePath.endsWith("archive.json") && !(value as { transaction?: unknown }).transaction) throw new Error("archive_finalize_failed"); store.save(value); } };
  }) as typeof createDurableJsonStore });
  const firstStart = !fs.existsSync(stateStore.path);
  const state = storage.load();
  const objectiveRecords = createObjectiveRecordsStore({ now: () => clock.value, isReserved: (id) => storage.entries().some((entry) => entry.objectiveRecord.id === id || entry.objectiveRecord.sessions?.some((child) => child.id === id)) });
  const theaters = new TheaterRegistry(); theaters.restore(firstStart ? [THEATER] : state.theaters);
  objectiveRecords.replace(state.objectiveRecords); objectiveRecords.replaceGroups(state.groups ?? []);
  const events: Array<{ channel: string; objectiveRecord: ObjectiveRecord }> = [];
  const purged: string[] = [];
  const stopped: string[] = [];
  const retention = { days: null as null | 7 | 30 | 90 };
  const scheduled: Array<{ delay: number; run: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const cleared = new Set<unknown>();
  const stopGate: { current: Promise<void> | null } = { current: null };
  const snapshot = (tombstones = deletion.list()): DurableConsoleState => ({ version: STATE_VERSION, theaters: theaters.list(), objectiveRecords: objectiveRecords.list(), groups: objectiveRecords.listAllGroups(), deletionTombstones: tombstones });
  const save = (tombstones?: readonly DurableDeletionTombstone[], entries?: readonly ArchivedObjective[]) => storage.save(snapshot(tombstones), entries);
  const deletion = createDeferredDeletionCoordinator({ objectiveRecords, theaters, archives: storage.entries, save,
    assertMutable: (id) => archive.assertMutable(id),
    now: () => clock.value, beforePurge: (nodes) => purged.push(...nodes.map((node) => node.id).sort()),
    publish: () => {}, unregisterTheaterWorkspaces: () => {}, validateTheaterRestore: async () => {}, registerTheaterWorkspace: async () => {},
    setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {},
  });
  deletion.load(state.deletionTombstones ?? []);
  const archive = createObjectiveArchiveCoordinator({ objectiveRecords, storage, snapshot,
    theaterExists: (id) => !!theaters.get(id), pendingDeletion: deletion.hasPendingObjective,
    stop: async (node) => { stopped.push(node.id); if (stopGate.current) await stopGate.current; }, use: async () => {}, now: () => clock.value,
    publish: (event) => events.push(event), publishChanged: () => {},
    readRetentionDays: () => retention.days,
    setTimer: ((run: () => void, delay: number) => {
      const handle = { unref() {} } as ReturnType<typeof setTimeout>;
      scheduled.push({ delay, run, handle });
      return handle;
    }) as typeof setTimeout,
    clearTimer: ((handle: ReturnType<typeof setTimeout>) => { cleared.add(handle); }) as typeof clearTimeout,
  });
  return { objectiveRecords, theaters, archive, deletion, storage, save, fault, clock, events, purged, stopped, retention, scheduled, cleared, stopGate };
}

function createHarness() {
  const clock = { value: 1_000 };
  const failSave = { value: false };
  const beforePurge: { value: ((objectiveRecords: readonly ObjectiveRecord[], tombstone: DurableDeletionTombstone) => void) | null } = { value: null };
  const objectiveRecords = createObjectiveRecordsStore({ now: () => clock.value });
  const theaters = new TheaterRegistry();
  theaters.restore([THEATER]);
  const events: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const coordinator = createDeferredDeletionCoordinator({
    objectiveRecords,
    theaters,
    now: () => clock.value,
    randomId: () => `deletion-${clock.value}`,
    save: () => {
      if (failSave.value) throw new Error("save_failed");
    },
    beforePurge: (purged, tombstone) => beforePurge.value?.(purged, tombstone),
    publish: (channel, payload) => events.push({ channel, payload }),
    unregisterTheaterWorkspaces: vi.fn(),
    validateTheaterRestore: async () => {},
    registerTheaterWorkspace: async () => {},
    setTimer: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  return { beforePurge, clock, coordinator, events, failSave, objectiveRecords, theaters };
}

function makeObjective(id: string) {
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
    kind: "objectiveRecord",
    objectiveRecord: {
      ...makeObjective("expired-op"),
      ts: { createdAt: 1, updatedAt: 1 },
    },
  };
}
