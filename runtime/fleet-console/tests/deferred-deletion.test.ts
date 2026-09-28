import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createConsoleControl } from "../features/console-use/host/console-control.js";
import { createLaunchKeyLedger } from "../features/console-use/host/launch-keys.js";

import { createDeferredDeletionCoordinator, DeferredDeletionError } from "../features/workspace/host/deferred-deletion.js";
import { createTheaterSystemPromptService } from "../features/settings/host/agent-options.js";
import type { AgentOptionsData } from "@fleet-console/infra";
import { STATE_VERSION, type DurableConsoleState, type DurableDeletionTombstone } from "../features/workspace/host/durable-state.js";
import { createDurableJsonStore, type DurableJsonStore } from "@fleet-console/infra";
import { createOperationArchiveStorage, type ArchivedOperation } from "../features/workspace/host/operation-archive-storage.js";
import { createOperationArchiveCoordinator } from "../features/workspace/host/operation-archive.js";
import { createOperationArchiveRouter } from "../features/workspace/host/operation-archive-routes.js";
import { createSanitizedOpDto, createOperationStore, type OperationNode } from "../features/execution/host/operations/operations-domain.js";
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
    const deletion = harness.coordinator.deleteTheater(THEATER.id);
    if (!deletion) throw new Error("expected deletion");

    const restored = await harness.coordinator.restore(deletion.deletionId);

    expect(restored).toEqual({ ok: true, kind: "theater", targetId: THEATER.id });
    expect(harness.theaters.get(THEATER.id)).toEqual(THEATER);
    expect(harness.operations.listByTheater(THEATER.id).map((operation) => operation.id)).toEqual(["op-a", "op-b"]);
    expect(harness.operations.listGroups(THEATER.id).map((group) => group.id)).toEqual(["group-a"]);
    expect(harness.events.filter((event) => event.channel === "operation:restored")).toHaveLength(2);
  });

  it("hides a forgotten Theater prompt, restores it during grace, and purges it after expiry", async () => {
    const harness = createHarness();
    let data: AgentOptionsData = { claudeCodeDisabledAgents: ["Explore"] };
    const options = { load: () => data, update: (mutate: (current: AgentOptionsData) => AgentOptionsData) => (data = mutate(data)) };
    const prompts = createTheaterSystemPromptService(options, (id) => harness.theaters.get(id) !== null);
    prompts.save(THEATER.id, { mode: "off", body: "private instructions" });
    harness.beforePurge.value = (_nodes, tombstone) => { if (tombstone.kind === "theater") prompts.purge(tombstone.targetId); };
    const deletion = harness.coordinator.deleteTheater(THEATER.id)!;
    expect(prompts.read(THEATER.id)).toBeNull();
    await harness.coordinator.restore(deletion.deletionId);
    expect(prompts.read(THEATER.id)).toEqual({ mode: "off", body: "private instructions" });
    const again = harness.coordinator.deleteTheater(THEATER.id)!;
    harness.clock.value = again.expiresAt;
    harness.coordinator.sweepExpired();
    expect(data).toEqual({ claudeCodeDisabledAgents: ["Explore"] });
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

describe("Operation archive persistence and deletion", () => {
  // 기존 유예 삭제 시험은 두 파일 이동·자식 세션 보존·복원 경계를 거치지 않는다.
  it("parks an Operation with its child sessions and restores the complete dormant record", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      h.operations.create({ ...makeOperation("parent"), pluginId: null, payload: { session: { harness: "claude-code", id: "provider-session", transcriptPath: "/private/transcript" } } });
      h.operations.createChild({ parentOperationId: "parent", childSessionId: "11111111-1111-4111-8111-111111111111" });
      h.save();
      await expect(h.archive.archive("11111111-1111-4111-8111-111111111111")).rejects.toThrow("child_session_not_closable");
      const receipt = await h.archive.archive("parent");
      expect(h.stopped).toEqual(["parent", "11111111-1111-4111-8111-111111111111"]);
      expect(h.operations.list()).toEqual([]);
      expect(h.archive.describe("11111111-1111-4111-8111-111111111111")?.location).toBe("archived");
      expect(h.operations.get("11111111-1111-4111-8111-111111111111")).toBeNull();
      expect(h.events.map((event) => event.channel)).toEqual(["operation:archived"]);
      expect(() => h.operations.create(makeOperation("11111111-1111-4111-8111-111111111111"))).toThrow("operation_exists");
      expect(JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).operations.map((node: OperationNode) => node.id)).toEqual([]);
      const router = createOperationArchiveRouter({ archive: h.archive, isAuthorized: () => false,
        readJsonBody: async <T,>() => ({}) as T, sanitize: createSanitizedOpDto,
        writeJson: (res, status, body) => Object.assign(res, { status, body }),
      });
      const readback: { status?: number; body?: unknown } = {};
      await router({ req: { method: "GET" } as never, res: readback as never, pathname: "/api/v1/operations/parent/describe" });
      expect(readback.status).toBe(200);
      expect(JSON.stringify(readback.body)).not.toMatch(/provider-session|\/private\/transcript/);
      const denied: { status?: number } = {};
      await router({ req: { method: "POST" } as never, res: denied as never, pathname: "/api/v1/operations/child/restore" });
      expect(denied.status).toBe(401);
      expect(h.operations.get("11111111-1111-4111-8111-111111111111")).toBeNull();
      const restarted = createArchiveHarness(directory);
      expect(restarted.archive.listArchived().total).toBe(1);
      const restored = await restarted.archive.undoArchive(receipt);
      expect(restored.rootOperationId).toBe("parent");
      expect(restored.operations.map((node) => node.id).sort()).toEqual(["parent"]);
      expect(restored.operations.every((node) => node.payload.restoredDormant === true)).toBe(true);
      expect(restarted.operations.get("parent")?.payload.session).toEqual({ harness: "claude-code", id: "provider-session", transcriptPath: "/private/transcript" });
      expect(restarted.operations.get("11111111-1111-4111-8111-111111111111")?.payload.restoredDormant).toBe(true);
      expect(restarted.operations.list()).toHaveLength(1);
      expect(restarted.archive.listArchived().entries).toEqual([]);
      await restarted.archive.archive("parent");
      const confirm = restarted.archive.previewPurge("parent");
      await expect(restarted.archive.purge({ ...confirm, revision: confirm.revision - 1 })).rejects.toThrow("archive_revision_conflict");
      await restarted.archive.purge(confirm);
      expect(restarted.events.filter((event) => event.channel === "operation:purged").map((event) => event.operation.id).sort()).toEqual(["parent"]);
      expect(createArchiveHarness(directory).archive.describe("parent")).toBeNull();
    });
  });

  it("recovers a durable move before publishing either storage location after a crash", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      h.operations.create(makeOperation("op")); h.save();
      h.fault.state = true;
      await expect(h.archive.archive("op")).rejects.toThrow("state_write_failed");
      expect(() => h.save()).toThrow("archive_recovery_required");
      expect(h.events).toEqual([]);
      const recovered = createArchiveHarness(directory);
      expect(recovered.operations.get("op")).toBeNull();
      expect(recovered.archive.describe("op")?.location).toBe("archived");
      recovered.fault.finalize = true;
      await expect(recovered.archive.restore("op")).rejects.toThrow("archive_finalize_failed");
      const restored = createArchiveHarness(directory);
      expect(restored.operations.get("op")).not.toBeNull();
      expect(restored.archive.listArchived().total).toBe(0);
      expect(restored.operations.list()).toHaveLength(1);
    });
  });

  it("deletes archived clusters through grace and purge, preserving original locations on Theater undo", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory);
      h.operations.create(makeOperation("parent"));
      h.operations.createChild({ parentOperationId: "parent", childSessionId: "11111111-1111-4111-8111-111111111111" }); h.save();
      await h.archive.archive("parent");
      const theaterDeletion = h.deletion.deleteTheater(THEATER.id)!;
      expect(theaterDeletion.archivedOperationCount).toBe(1);
      await h.deletion.restore(theaterDeletion.deletionId);
      expect(h.operations.get("parent")).toBeNull();
      expect(h.operations.get("11111111-1111-4111-8111-111111111111")).toBeNull();
      expect(h.archive.describe("11111111-1111-4111-8111-111111111111")?.location).toBe("archived");
      await h.archive.archive("parent");
      const deletion = h.deletion.deleteOperation("parent")!;
      expect(h.archive.listArchived().total).toBe(0);
      await expect(h.archive.access("11111111-1111-4111-8111-111111111111")).rejects.toThrow("pending_deletion");
      h.clock.value = deletion.expiresAt;
      h.deletion.sweepExpired();
      expect(h.purged).toEqual(["parent"]);
      const boot = createArchiveHarness(directory);
      expect(boot.archive.listArchived().total).toBe(0);
      expect(boot.deletion.list()).toEqual([]);
      expect(boot.operations.list()).toEqual([]);
      expect(fs.readFileSync(path.join(directory, "operations-archive.json"), "utf8")).not.toContain('"id": "parent"');
    });
  });

  it("refuses corrupt or conflicting stores instead of replacing them with empty state", async () => {
    await withArchiveDirectory(async (directory) => {
      const h = createArchiveHarness(directory); h.operations.create(makeOperation("op")); h.save();
      await h.archive.archive("op");
      const archiveFile = path.join(directory, "operations-archive.json");
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
  const storage = createOperationArchiveStorage({ directory, stateStore, createStore: ((deps: Parameters<typeof createDurableJsonStore>[0]) => {
    const store = createDurableJsonStore(deps);
    return { ...store, save: (value: unknown) => { if (fault.finalize && !(value as { transaction?: unknown }).transaction) throw new Error("archive_finalize_failed"); store.save(value); } };
  }) as typeof createDurableJsonStore });
  const state = storage.load();
  const operations = createOperationStore({ now: () => clock.value, isReserved: (id) => storage.entries().some((entry) => entry.operation.id === id || entry.operation.childSessions?.some((child) => child.id === id)) });
  const theaters = new TheaterRegistry(); theaters.restore(state.theaters.length ? state.theaters : [THEATER]);
  operations.replace(state.operations); operations.replaceGroups(state.groups ?? []);
  const events: Array<{ channel: string; operation: OperationNode }> = [];
  const purged: string[] = [];
  const stopped: string[] = [];
  const snapshot = (tombstones = deletion.list()): DurableConsoleState => ({ version: STATE_VERSION, theaters: theaters.list(), operations: operations.list(), groups: operations.listAllGroups(), deletionTombstones: tombstones });
  const save = (tombstones?: readonly DurableDeletionTombstone[], entries?: readonly ArchivedOperation[]) => storage.save(snapshot(tombstones), entries);
  const deletion = createDeferredDeletionCoordinator({ operations, theaters, archives: storage.entries, save,
    now: () => clock.value, beforePurge: (nodes) => purged.push(...nodes.map((node) => node.id).sort()),
    publish: () => {}, unregisterTheaterWorkspaces: () => {}, validateTheaterRestore: async () => {}, registerTheaterWorkspace: async () => {},
    setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {},
  });
  deletion.load(state.deletionTombstones ?? []);
  const archive = createOperationArchiveCoordinator({ operations, storage, snapshot,
    theaterExists: (id) => !!theaters.get(id), pendingDeletion: deletion.hasPendingOperation,
    stop: async (node) => { stopped.push(node.id); }, use: async () => {}, now: () => clock.value,
    publish: (event) => events.push(event), publishChanged: () => {},
  });
  return { operations, theaters, archive, deletion, storage, save, fault, clock, events, purged, stopped };
}

describe("idempotent launch keys", () => {
  // 저장 무결성 경계 — 키 하나에 Operation 은 많아야 하나, 사람이 지운 키는 purge·재시작 뒤에도 다시 생기지 않는다.
  it("creates at most one Operation per key and keeps a deleted key deleted across purge and restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-launch-keys-"));
    try {
      const harness = createHarness();
      let executions = 0;
      const boot = () => {
        const launchKeys = createLaunchKeyLedger({
          directory, limit: 2,
          operations: () => harness.operations.list(),
          tombstoned: () => harness.coordinator.list().flatMap((item) => item.kind === "operation" ? [item.operation] : item.operations),
        });
        const control = createConsoleControl({ directory, launchKeys, pluginAvailable: () => true, operations: () => harness.operations.list(), theaters: () => [{ id: THEATER.id, name: "theater" }] });
        control.attach({
          observe: () => null,
          execute: async (input, _assertCurrent, _settled, caller) => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            const id = input.newOperationId ?? `launched-${executions}`;
            harness.operations.create({ ...makeOperation(id), pluginId: null, payload: { launchKey: { owner: (caller as { pluginId: string }).pluginId, key: input.launchKey } } });
            return { operationId: id, delivery: "requested" };
          },
        });
        harness.beforePurge.value = (purged) => launchKeys.recordPurged(purged);
        return { launchKeys, control };
      };
      const caller = { kind: "plugin" as const, pluginId: "objectives" };
      const objectiveId = "11111111-2222-4333-8444-555555555555";
      const launch = { kind: "launch" as const, theaterId: THEATER.id, dormant: true, launchKey: "objectives.followup:a", newOperationId: objectiveId };

      const first = boot();
      await expect(first.control.request(caller, { ...launch, launchKey: undefined })).rejects.toThrow();
      await expect(first.control.request({ kind: "operation", operationId: "unrelated" }, launch)).rejects.toThrow();
      // 같은 키가 동시에 두 번 와도, 이미 선 뒤에 다시 와도 기동은 한 번이다.
      const [a, b] = await Promise.all([first.control.request(caller, launch), first.control.request(caller, launch)]);
      expect([a.operationId, b.operationId]).toEqual([objectiveId, objectiveId]);
      expect((await first.control.request(caller, launch)).operationId).toBe(objectiveId);
      expect(executions).toBe(1);
      expect(first.control.launchKeyState(caller, THEATER.id, "objectives.followup:a")).toEqual({ state: "live", operationId: objectiveId });
      // 다른 Theater 로 묻는 키는 그 Operation 을 드러내지 않는다.
      expect(() => first.control.launchKeyState(caller, "other", "objectives.followup:a")).toThrow();

      harness.operations.create(makeOperation("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"));
      await expect(first.control.request(caller, { ...launch, launchKey: "objectives.followup:collision", newOperationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" })).rejects.toThrow("operation_id_taken");
      // 용량이 차면 새 키는 받지 않지만, 이미 수락한 키의 삭제 기록은 막지 않는다.
      first.control.reserveLaunchKeys(caller, THEATER.id, ["objectives.followup:b"]);
      expect(() => first.control.reserveLaunchKeys(caller, THEATER.id, ["objectives.followup:c"])).toThrow("launch_key_capacity");
      harness.operations.create(makeOperation("unrelated"));
      harness.coordinator.deleteOperation("unrelated");
      harness.clock.value += 1; // 테스트 삭제 id 는 시각에서 나온다.
      harness.coordinator.deleteOperation(objectiveId);
      expect(first.control.launchKeyState(caller, THEATER.id, "objectives.followup:a").state).toBe("deleting");
      harness.clock.value += 60_000;
      // 원장 선기록이 실패하면 그 tombstone 만 남아 미뤄진다 — 다른 정리와 무관한 생성·삭제는 막히지 않는다.
      const record = harness.beforePurge.value!;
      harness.beforePurge.value = (purged, tombstone) => { if (purged.some((node) => node.id === objectiveId)) throw new Error("storage_unavailable"); record(purged, tombstone); };
      expect(harness.coordinator.hasPendingOperation("brand-new")).toBe(false);
      expect(harness.coordinator.hasPendingOperation("unrelated")).toBe(false);
      harness.operations.create(makeOperation("brand-new"));
      harness.clock.value += 1;
      expect(harness.coordinator.deleteOperation("brand-new")).not.toBeNull();
      expect(first.control.launchKeyState(caller, THEATER.id, "objectives.followup:a").state).toBe("deleting");
      harness.beforePurge.value = record;
      harness.clock.value += 60_000;
      harness.coordinator.sweepExpired();
      expect(harness.coordinator.hasPendingOperation(objectiveId)).toBe(false);
      first.control.dispose();

      // 재시작 — 흔적이 사라진 뒤에도 원장이 purge 를 말하고, 같은 키의 기동은 거절된다.
      const restarted = boot();
      expect(restarted.control.launchKeyState(caller, THEATER.id, "objectives.followup:a")).toEqual({ state: "purged", operationId: objectiveId });
      await expect(restarted.control.request(caller, launch)).rejects.toThrow("launch_key_deleted");
      expect(restarted.control.launchKeyState(caller, THEATER.id, "objectives.followup:b").state).toBe("reserved");
      expect(executions).toBe(1);
      // 호스트 상태가 비워져 Operation 이 흔적 없이 사라져도, 선 적이 있는 키는 다시 만들지 않는다.
      const keyedB = { ...launch, launchKey: "objectives.followup:b", newOperationId: "66666666-7777-4888-9999-aaaaaaaaaaaa" };
      expect((await restarted.control.request(caller, keyedB)).operationId).toBe(keyedB.newOperationId);
      harness.operations.replace([]);
      expect(restarted.control.launchKeyState(caller, THEATER.id, "objectives.followup:b").state).toBe("purged");
      await expect(restarted.control.request(caller, keyedB)).rejects.toThrow("launch_key_deleted");
      expect(executions).toBe(2);
      restarted.control.dispose();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

function createHarness() {
  const clock = { value: 1_000 };
  const failSave = { value: false };
  const beforePurge: { value: ((operations: readonly OperationNode[], tombstone: DurableDeletionTombstone) => void) | null } = { value: null };
  const operations = createOperationStore({ now: () => clock.value });
  const theaters = new TheaterRegistry();
  theaters.restore([THEATER]);
  const events: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const coordinator = createDeferredDeletionCoordinator({
    operations,
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
  return { beforePurge, clock, coordinator, events, failSave, operations, theaters };
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
