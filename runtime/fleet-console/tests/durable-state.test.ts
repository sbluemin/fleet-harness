import { createObjectiveStorage } from "../features/objectives/host/storage.js";
import { createObjectiveRecordsStore } from "../features/objectives/host/records/objective-records-domain.js";
import { createObjectiveStore } from "../features/objectives/host/store.js";
import { createDurableJsonStore } from "@fleet-console/infra";
import { ensureWorkspaceDirectory } from "@fleet-console/infra/workspace-dir";
import type { DurableConsoleState } from "../features/workspace/host/durable-state.js";
import { createDeferredDeletionCoordinator } from "../features/workspace/host/deferred-deletion.js";
import { TheaterRegistry } from "../features/workspace/host/theaters/theater-domain.js";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDurableStateV3, readDurableStateVersion, sanitizeDurableConsoleState } from "../features/workspace/host/durable-state.js";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = path.resolve(".fleet/isolated/durable-tests"); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "case-")); tempDirs.push(directory);
  const destination = path.join(directory, "commodore/owner/objectives");
  const owner = { commodoreId: "c1", legacyTheaterId: "t1", legacyCwd: directory, theaterIdOf: () => "t1", directory: destination };
  const registration = { id: "t1", path: directory, realpath: directory, label: "project", registeredAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" };
  const source = { version: 6, theaters: [registration] };
  const stateFile = path.join(directory, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(source));
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "groups.json"), JSON.stringify({ groups: [] }));
  const stateStore = createDurableJsonStore<DurableConsoleState>({ filePath: stateFile, lockDir: null, sensitivity: "sensitive", sanitize: sanitizeDurableConsoleState });
  const open = () => createObjectiveStorage({ directory, stateStore, owners: () => [owner] });
  const file = (id: string) => path.join(destination, id, "objective.json");
  const archiveFile = path.join(destination, "archive.json");
  const put = (id: string, value: unknown) => { fs.mkdirSync(path.dirname(file(id)), { recursive: true }); fs.writeFileSync(file(id), JSON.stringify(value)); };
  const doc = (id: string) => ({ id, cwd: directory, title: id, rank: 1, note: `Board ${id}`, missions: [], ts: { createdAt: 1, updatedAt: 2 }, session: { harness: "claude-code", id: `private-${id}` } });
  return { directory, destination, owner, registration, source, stateFile, stateStore, open, file, archiveFile, put, doc };
}

describe("durable console state", () => {
  it("falls back to an empty state for version mismatch or malformed data", () => {
    expect(sanitizeDurableConsoleState({ version: 1, theaters: [], objectiveRecords: [] })).toEqual({ version: 6, theaters: [], objectiveRecords: [], groups: [], deletionTombstones: [] });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ id: "" }], objectiveRecords: [{ id: "" }] })).toEqual({ version: 6, theaters: [], objectiveRecords: [], groups: [], deletionTombstones: [] });
  });

  // 직전 인라인 형식을 실제 저장소·보드·봉인 증거 경계로 올린다. 더 오래된 위치 이동 시험을 대체한다.
  it("extracts inline bodies without losing source bytes, skips conflicts, and never revives inactive files", async () => {
    const h = fixture();
    // 이전 위치 정리가 미뤄져도 현재 owner가 권위다. 옛 본문은 읽거나 지우지 않는다.
    const leftoverBoard = path.join(ensureWorkspaceDirectory(h.directory, h.directory).path, "objectives");
    fs.mkdirSync(leftoverBoard); fs.writeFileSync(path.join(leftoverBoard, "untouched"), "older board");
    const leftoverArchive = path.join(h.directory, "operations-archive.json");
    const leftoverBytes = JSON.stringify({ entries: [{ operation: { theaterId: "t1", id: "older" } }] });
    fs.writeFileSync(leftoverArchive, leftoverBytes);
    const bytes = Buffer.from("sealed proof");
    const evidence = { evidenceId: "d7f24ad7-6854-4b2a-8802-e4f242b30629", name: "proof.txt", mediaType: "text/plain", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: 1 };
    const result = { ...evidence, kind: "evidence", id: "e9d2bf4c-a424-45aa-92aa-d87b4fd78bcc", createdAt: 1, updatedAt: 2 };
    const otherProject = path.join(h.directory, "B"); fs.mkdirSync(otherProject);
    const active = { ...h.doc("active"), cwd: otherProject, addedBy: { kind: "commodore", theaterId: "t1" }, launchedBy: { kind: "feature", featureId: "objectives" }, members: [{ id: "child", role: "Member", by: "human" }], sessions: [{ id: "child", ts: { createdAt: 1, updatedAt: 2 }, launchedBy: { kind: "feature", featureId: "objectives" }, session: { harness: "claude-code", id: "private-child" } }] };
    const archived = { ...h.doc("archived"), evidence: [{ ...evidence, ownerObjectiveId: "archived" }], results: [result] };
    const conflict = h.doc("conflict"), existing = { ...conflict, note: "different original" };
    h.put("active", active); h.put("conflict", existing);
    const originalActive = fs.readFileSync(h.file("active"), "utf8");
    fs.mkdirSync(path.join(h.destination, "archived/evidence"), { recursive: true });
    fs.writeFileSync(path.join(h.destination, "archived/evidence", `${evidence.evidenceId}.txt`), bytes);
    fs.mkdirSync(path.join(h.destination, "archived/shared"));
    const link = path.join(h.destination, "archived/shared/missing.ts"), target = path.join(h.directory, "missing-worktree/file.ts");
    fs.symlinkSync(target, link);
    const outside = path.join(h.directory, "outside");
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "objective.json"), "outside original");
    fs.symlinkSync(outside, path.join(h.destination, "linked"));
    const source = JSON.stringify({ revision: 3,
      entries: [archived, h.doc("absent-directory"), conflict, h.doc("linked")].map((objective) => ({ archiveId: `archive-${objective.id}`, archivedAt: 3, objective })),
      deletions: [{ deletionId: "delete-1", kind: "objective", targetId: "deleted", deletedAt: 1, expiresAt: 999999, objective: h.doc("deleted"), archived: { deleted: { archiveId: "was-archived", archivedAt: 2 } } }],
      events: [{ eventId: "purged-event", channel: "objective:purged", objective: h.doc("already-purged") }],
    });
    fs.writeFileSync(h.archiveFile, source);
    const interrupted = createObjectiveStorage({ directory: h.directory, stateStore: h.stateStore, owners: () => [h.owner],
      createStore: ((deps: Parameters<typeof createDurableJsonStore>[0]) => {
        const store = createDurableJsonStore(deps);
        return { ...store, save: (value: unknown) => { if (deps.filePath === h.file("absent-directory")) throw new Error("commit_interrupted"); store.save(value); } };
      }) as typeof createDurableJsonStore,
    });
    expect(interrupted.load().objectiveRecords).toEqual([]);
    expect(interrupted.blocked()).toBe(false);
    expect(interrupted.board.directory("c1")).toBeNull();
    expect(() => interrupted.board.save("c1", { ...h.doc("new"), pending: true })).toThrow("objective_owner_unavailable");
    expect(fs.readFileSync(h.archiveFile, "utf8")).toBe(source);
    const moved = h.open(); const state = moved.load();
    expect(state.objectiveRecords.map((node) => node.id)).toEqual(["active"]);
    expect(moved.entries().map((entry) => entry.objectiveRecord.id)).toEqual(["archived", "absent-directory"]);
    expect(moved.isReserved("conflict")).toBe(true);
    expect(moved.isReserved("linked")).toBe(true);
    expect(fs.readFileSync(path.join(outside, "objective.json"), "utf8")).toBe("outside original");
    expect(fs.readlinkSync(path.join(h.destination, "linked"))).toBe(outside);
    expect(() => moved.board.save("c1", { ...existing, theaterId: "t1" })).toThrow("archive_recovery_required");
    expect(JSON.parse(fs.readFileSync(h.file("archived"), "utf8"))).toEqual(archived);
    expect(JSON.parse(fs.readFileSync(h.file("deleted"), "utf8"))).toEqual(h.doc("deleted"));
    expect(JSON.parse(fs.readFileSync(h.file("conflict"), "utf8"))).toEqual(existing);
    expect(fs.readFileSync(h.file("active"), "utf8")).toBe(originalActive);
    expect(fs.existsSync(h.file("already-purged"))).toBe(false);
    expect(moved.events()).toEqual([{ eventId: "purged-event", channel: "objective:purged", objectiveId: "already-purged", commodoreId: "c1", theaterId: "t1", sessionIds: [] }]);
    const archive = JSON.parse(fs.readFileSync(h.archiveFile, "utf8"));
    expect(archive.entries).toEqual(["archived", "absent-directory", "conflict", "linked"].map((objectiveId) => ({ objectiveId, archiveId: `archive-${objectiveId}`, archivedAt: 3 })));
    expect(archive.deletions[0]).toMatchObject({ objectiveIds: ["deleted"], archived: { deleted: { archiveId: "was-archived", archivedAt: 2 } } });
    expect(fs.readFileSync(h.archiveFile, "utf8")).not.toMatch(/Board |private-|sealed proof/);
    const backup = path.join(h.destination, ".archive-migration", `${createHash("sha256").update(source).digest("hex")}.json`);
    expect(fs.readFileSync(backup, "utf8")).toBe(source);
    expect(fs.readlinkSync(link)).toBe(target); expect(fs.existsSync(target)).toBe(false);
    moved.board.save("c1", { ...moved.board.list("c1").find((row) => row.id === "archived")!, note: "Edited archive" });
    moved.save(state);
    const reopened = h.open(); const restored = reopened.load();
    expect(restored.objectiveRecords.map((node) => node.id)).toEqual(["active"]);
    expect(reopened.board.list("c1").find((row) => row.id === "archived")?.note).toBe("Edited archive");
    expect(fs.readFileSync(backup, "utf8")).toBe(source);
    const records = createObjectiveRecordsStore(); records.replace(restored.objectiveRecords);
    const boardStore = createObjectiveStore({ storage: reopened.board, dirOf: reopened.board.directory, commodoreIds: () => ["c1"], objectiveRecords: records, emit: () => {} });
    expect(() => records.deleteChild("child", "another-feature")).toThrow("child_delete_forbidden");
    expect(records.deleteChild("child", "objectives")).toBe(true);
    reopened.save({ ...restored, objectiveRecords: records.list() });
    expect(boardStore.memberRemove("active", "child").objective.members).toHaveLength(0);
    reopened.save({ ...restored, objectiveRecords: records.list() });
    const after = h.open(); const afterState = after.load();
    expect(afterState.objectiveRecords[0]?.sessions ?? []).toHaveLength(0);
    expect(after.board.list("c1").find((row) => row.id === "active")?.memberHistory?.map((entry) => entry.kind)).toEqual(["left"]);
    const entry = after.entries().find((row) => row.objectiveRecord.id === "archived")!;
    after.save({ ...afterState, objectiveRecords: [...afterState.objectiveRecords, entry.objectiveRecord] }, after.entries().filter((row) => row.objectiveRecord.id !== "archived"));
    const boot = h.open(); records.replace(boot.load().objectiveRecords);
    const boards = createObjectiveStore({ storage: boot.board, dirOf: boot.board.directory, commodoreIds: () => ["c1"], objectiveRecords: records, emit: () => {} });
    expect(boards.find("archived")?.note).toBe("Edited archive");
    expect((await boards.evidenceRead("archived", result.id)).data).toEqual(bytes);
    expect(boot.board.directory("c1")).toBe(h.destination);
    expect(fs.readFileSync(leftoverArchive, "utf8")).toBe(leftoverBytes);
    expect(fs.readFileSync(path.join(leftoverBoard, "untouched"), "utf8")).toBe("older board");

    // 소유자의 A와 목표의 B는 다르다. 읽기·실행 저장·보드 저장이 B를 A로 바꾸면 안 된다.
    const beforeRead = fs.readFileSync(h.file("active"), "utf8");
    const fixed = h.open(); const fixedState = fixed.load();
    expect(fs.readFileSync(h.file("active"), "utf8")).toBe(beforeRead);
    fixed.save({ ...fixedState, objectiveRecords: fixedState.objectiveRecords.map((record) => ({ ...record, cwd: h.directory })) });
    expect(JSON.parse(fs.readFileSync(h.file("active"), "utf8")).cwd).toBe(otherProject);
    fixed.board.save("c1", { ...fixed.board.list("c1").find((record) => record.id === "active")!, cwd: h.directory });
    expect(JSON.parse(fs.readFileSync(h.file("active"), "utf8")).cwd).toBe(otherProject);
    // 현행 옛 파일의 식별자 없는 행위자와 cwd 없는 미실행 목표는 읽기에서만 복구한다.
    const legacyFile = path.join(h.destination, "legacy-pending/objective.json");
    fs.mkdirSync(path.dirname(legacyFile));
    const legacyPending = JSON.stringify({ id: "legacy-pending", title: "Pending", pending: true, rank: 0, note: "keep", missions: [], ts: { createdAt: 1, updatedAt: 1 }, addedBy: { kind: "commodore", why: "keep" } });
    fs.writeFileSync(legacyFile, legacyPending);
    const legacyStore = h.open(); legacyStore.load();
    const pending = legacyStore.board.list("c1").find((record) => record.id === "legacy-pending")!;
    expect(pending).toMatchObject({ commodoreId: "c1", cwd: h.directory, addedBy: { kind: "commodore", commodoreId: "c1", why: "keep" } });
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacyPending);
    legacyStore.board.save("c1", pending);
    expect(JSON.parse(fs.readFileSync(legacyFile, "utf8")).cwd).toBe(h.directory);
    expect(() => legacyStore.board.save("c1", { ...pending, addedBy: { kind: "commodore", commodoreId: "other-owner" } })).toThrow("objective_actor_owner_mismatch");
    // 한 목표의 잘못된 소유자/위치는 기동과 형제 목표를 막지 않으며 다음 저장도 원본을 지우지 않는다.
    const badOwner = JSON.stringify({ ...JSON.parse(fs.readFileSync(legacyFile, "utf8")), addedBy: { kind: "commodore", commodoreId: "other-owner" } });
    fs.writeFileSync(legacyFile, badOwner);
    const badLocationFile = path.join(h.destination, "unlocated/objective.json");
    fs.mkdirSync(path.dirname(badLocationFile));
    const badLocation = JSON.stringify({ ...JSON.parse(legacyPending), id: "unlocated", cwd: "relative" });
    fs.writeFileSync(badLocationFile, badLocation);
    const isolated = h.open(); const readable = isolated.load();
    expect(readable.objectiveRecords.map((record) => record.id).sort()).toEqual(["active", "archived"]);
    expect(isolated.board.unavailable("legacy-pending")).toBe(true);
    expect(isolated.board.unavailable("unlocated")).toBe(true);
    expect(isolated.board.list("c1").map((record) => record.id)).not.toContain("legacy-pending");
    isolated.save(readable);
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(badOwner);
    expect(fs.readFileSync(badLocationFile, "utf8")).toBe(badLocation);
    expect(() => isolated.board.save("c1", pending)).toThrow("archive_recovery_required");
    // 보관 본문은 목표 파일에 남는다. 격리한 본문과 색인은 형제 저장 뒤에도 보존한다.
    isolated.save({ ...readable, objectiveRecords: readable.objectiveRecords.filter((record) => record.id !== "archived") }, [{ archiveId: "held-archive", archivedAt: 5, objectiveRecord: readable.objectiveRecords.find((record) => record.id === "archived")! }]);
    const corruptBody = { ...JSON.parse(fs.readFileSync(h.file("archived"), "utf8")), addedBy: { kind: "commodore", commodoreId: "other-owner" } };
    fs.writeFileSync(h.file("archived"), JSON.stringify(corruptBody));
    const indexBefore = JSON.parse(fs.readFileSync(h.archiveFile, "utf8")).entries;
    const archiveHeld = h.open(); const availableState = archiveHeld.load();
    expect(availableState.objectiveRecords.map((record) => record.id)).toEqual(["active"]);
    expect(archiveHeld.entries()).toEqual([]);
    archiveHeld.save(availableState);
    expect(JSON.parse(fs.readFileSync(h.archiveFile, "utf8")).entries).toEqual(indexBefore);
    expect(JSON.parse(fs.readFileSync(h.file("archived"), "utf8"))).toEqual(corruptBody);


    // 손상 행은 같은 owner의 정상 행과 다른 owner를 막지 않는다. 파싱 불능은 해당 owner만 멈춘다.
    const damaged = fixture();
    const healthy = { ...damaged.owner, commodoreId: "healthy", legacyTheaterId: "healthy", theaterIdOf: () => "healthy", directory: path.join(damaged.directory, "commodore/healthy/objectives") };
    const broken = { ...damaged.owner, commodoreId: "broken", legacyTheaterId: "broken", theaterIdOf: () => "broken", directory: path.join(damaged.directory, "commodore/broken/objectives") };
    const empty = { revision: 0, entries: [], deletions: [], events: [] };
    for (const owner of [healthy, broken]) {
      fs.mkdirSync(owner.directory, { recursive: true });
      fs.writeFileSync(path.join(owner.directory, "groups.json"), JSON.stringify({ groups: [] }));
    }
    fs.mkdirSync(path.join(healthy.directory, "live"));
    fs.writeFileSync(path.join(healthy.directory, "live/objective.json"), JSON.stringify(damaged.doc("live")));
    fs.writeFileSync(path.join(healthy.directory, "archive.json"), JSON.stringify({ ...empty, entries: [{ archiveId: "healthy-archive", archivedAt: 1, objective: damaged.doc("healthy-archived") }] }));
    fs.writeFileSync(path.join(broken.directory, "archive.json"), "{broken archive");
    fs.writeFileSync(damaged.stateFile, JSON.stringify({ ...damaged.source, theaters: [damaged.registration, ...[healthy, broken].map((owner) => ({ ...damaged.registration, id: owner.legacyTheaterId }))] }));
    for (const id of ["bad-event", "bad-deletion", "unrelated-active"]) damaged.put(id, damaged.doc(id));
    const damagedSource = JSON.stringify({ ...empty,
      entries: [{ archiveId: "good", archivedAt: 1, objective: damaged.doc("good") },
        { archiveId: "bad-id", archivedAt: 1, objective: damaged.doc("../unsafe") },
        { archiveId: "bad-body", archivedAt: 1, objective: "not an object" }],
      deletions: [{ deletionId: "bad-deletion-receipt", kind: "objective", targetId: "bad-deletion", deletedAt: 1, expiresAt: 999999, objective: 7 }],
      events: [{ eventId: "bad-event-id", channel: "objective:purged", objective: { id: "bad-event" } }],
    });
    fs.writeFileSync(damaged.archiveFile, damagedSource);
    const openAll = () => createObjectiveStorage({ directory: damaged.directory, stateStore: damaged.stateStore, owners: () => [damaged.owner, broken, healthy] });
    const partial = openAll(), partialState = partial.load();
    expect(partial.blocked()).toBe(false);
    expect(partialState.objectiveRecords.map((node) => node.id)).toEqual(["unrelated-active", "live"]);
    expect(partial.entries().map((row) => row.objectiveRecord.id)).toEqual(["good", "healthy-archived"]);
    expect(partial.board.directory("c1")).toBe(damaged.destination);
    expect(partial.board.directory("broken")).toBeNull();
    expect(partial.board.directory("healthy")).toBe(healthy.directory);
    for (const id of ["bad-event", "bad-deletion"]) {
      expect(partial.isReserved(id)).toBe(true);
      expect(JSON.parse(fs.readFileSync(damaged.file(id), "utf8"))).toEqual(damaged.doc(id));
    }
    const sourceHash = createHash("sha256").update(damagedSource).digest("hex");
    const isolationIndex = JSON.parse(fs.readFileSync(damaged.archiveFile, "utf8"));
    expect(isolationIndex.quarantine).toEqual([
      { id: "../unsafe", sourceHash, location: "entries[1]", reason: "invalid_inline_row" },
      { id: null, sourceHash, location: "entries[2]", reason: "invalid_inline_row" },
      { id: "bad-deletion", sourceHash, location: "deletions[0]", reason: "invalid_inline_row" },
      { id: "bad-event", sourceHash, location: "events[0]", reason: "invalid_inline_row" },
    ]);
    expect(fs.readFileSync(path.join(damaged.destination, ".archive-migration", `${sourceHash}.json`), "utf8")).toBe(damagedSource);
    const brokenHash = createHash("sha256").update("{broken archive").digest("hex");
    expect(fs.readFileSync(path.join(broken.directory, ".archive-migration", `${brokenHash}.json`), "utf8")).toBe("{broken archive");
    expect(fs.readFileSync(path.join(broken.directory, "archive.json"), "utf8")).toBe("{broken archive");
    partial.save(partialState);
    const retry = openAll(); const retryState = retry.load();
    expect(retryState.objectiveRecords.map((node) => node.id)).toEqual(["unrelated-active", "live"]);
    expect(retry.entries().map((row) => row.objectiveRecord.id)).toEqual(["good", "healthy-archived"]);
    expect(JSON.parse(fs.readFileSync(damaged.archiveFile, "utf8")).quarantine).toEqual(isolationIndex.quarantine);

    // 격리 deletion이 있는 owner의 Theater 삭제는 prepare 전에 거절한다. 호출자의 메모리도 복구된다.
    const deletionRecords = createObjectiveRecordsStore(); deletionRecords.replace(retryState.objectiveRecords);
    const theaters = new TheaterRegistry(); theaters.restore(retryState.theaters);
    const coordinator = createDeferredDeletionCoordinator({ objectiveRecords: deletionRecords, theaters, archives: retry.entries,
      save: (tombstones, archives) => retry.save({ ...retryState, theaters: theaters.list(), objectiveRecords: deletionRecords.list(), deletionTombstones: tombstones }, archives),
      publish: () => {}, unregisterTheaterWorkspaces: () => {}, validateTheaterRestore: async () => {}, registerTheaterWorkspace: async () => {},
      now: () => 1, setTimer: () => ({ unref() {} }) as never, clearTimer: () => {},
    });
    coordinator.load(retryState.deletionTombstones ?? []);
    const beforeDelete = [damaged.stateFile, damaged.archiveFile].map((file) => fs.readFileSync(file, "utf8"));
    expect(() => coordinator.deleteTheater("t1")).toThrow("objective_owner_recovery_required");
    expect([damaged.stateFile, damaged.archiveFile].map((file) => fs.readFileSync(file, "utf8"))).toEqual(beforeDelete);
    expect(theaters.get("t1")).not.toBeNull();
    expect(deletionRecords.get("unrelated-active")).not.toBeNull();
    expect(coordinator.list()).toEqual([]);
    expect(retry.blocked()).toBe(false);
    const afterDenied = openAll();
    expect(afterDenied.load().objectiveRecords.map((node) => node.id)).toEqual(["unrelated-active", "live"]);
    expect(afterDenied.board.directory("c1")).toBe(damaged.destination);
    // 정상 owner의 삭제는 계속 허용하며 state 등록과 archive tombstone이 함께 재기동된다.
    const receipt = coordinator.deleteTheater("healthy")!;
    coordinator.dispose();
    const afterAllowed = openAll(); const allowedState = afterAllowed.load();
    expect(afterAllowed.blocked()).toBe(false);
    expect(allowedState.theaters.some((row) => row.id === "healthy")).toBe(false);
    expect(allowedState.deletionTombstones?.some((row) => row.deletionId === receipt.deletionId && row.kind === "theater" && row.targetId === "healthy")).toBe(true);

    // 이전 코드로 이미 생긴 불일치도 전역 기동 실패로 번지지 않는다. 연결을 잃은 삭제 행만 격리한다.
    const mismatched = JSON.parse(fs.readFileSync(damaged.archiveFile, "utf8"));
    mismatched.entries = [];
    mismatched.deletions.push({ deletionId: "orphan-theater", kind: "theater", targetId: "t1", deletedAt: 1, expiresAt: 999999, objectiveIds: ["good", "unrelated-active"], groups: [] });
    fs.writeFileSync(damaged.archiveFile, JSON.stringify(mismatched));
    const orphaned = openAll(); const orphanState = orphaned.load();
    expect(orphaned.blocked()).toBe(false);
    expect(orphaned.board.directory("healthy")).toBe(healthy.directory);
    expect(orphanState.deletionTombstones?.some((row) => row.deletionId === receipt.deletionId)).toBe(true);
    expect(orphaned.isReserved("good")).toBe(true);
    expect(orphanState.objectiveRecords.some((row) => row.id === "unrelated-active")).toBe(false);
    expect(JSON.parse(fs.readFileSync(damaged.archiveFile, "utf8")).quarantine).toContainEqual(expect.objectContaining({ id: "t1", reason: "missing_theater_registration" }));
    expect(() => openAll().load()).not.toThrow();
  });

  // 준비된 직전 transaction과 금지된 옛 위치는 서로 다른 복구 경계다.
  it("recovers an inline prepared transaction and preserves unsupported older sources", () => {
    const h = fixture();
    const before = h.doc("active"), after = { ...before, note: "committed board" };
    h.put("active", before);
    const source = JSON.stringify({ revision: 0, entries: [], deletions: [], events: [], transaction: {
      documents: [after], groups: [], state: h.source,
      archive: { revision: 1, entries: [{ archiveId: "a", archivedAt: 1, objective: h.doc("archived") }], deletions: [], events: [{ eventId: "e", channel: "objective:archived", objective: h.doc("archived") }] },
    } });
    fs.writeFileSync(h.archiveFile, source);
    const moved = h.open();
    expect(moved.load().objectiveRecords[0]?.note).toBe("committed board");
    expect(moved.entries()[0]?.objectiveRecord.id).toBe("archived");
    expect(fs.readdirSync(path.join(h.destination, ".transactions"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(h.archiveFile, "utf8"))).not.toHaveProperty("transaction");
    expect(h.open().load().objectiveRecords[0]?.note).toBe("committed board");
    const legacy = fixture();
    fs.rmSync(legacy.destination, { recursive: true });
    const oldBoard = path.join(ensureWorkspaceDirectory(legacy.directory, legacy.directory).path, "objectives");
    fs.mkdirSync(oldBoard); fs.writeFileSync(path.join(oldBoard, "untouched"), "older original");
    const oldArchive = path.join(legacy.directory, "operations-archive.json");
    fs.writeFileSync(oldArchive, "older archive bytes");
    const marker = `${legacy.stateFile}.objectives-migration.json`;
    fs.writeFileSync(marker, "old marker bytes");
    const unavailable = legacy.open(); expect(unavailable.load().objectiveRecords).toEqual([]);
    expect(unavailable.board.directory("c1")).toBeNull();
    expect(() => unavailable.board.save("c1", { ...legacy.doc("new"), pending: true })).toThrow("objective_owner_unavailable");
    expect(fs.existsSync(legacy.destination)).toBe(false);
    expect(fs.readFileSync(oldArchive, "utf8")).toBe("older archive bytes");
    expect(fs.readFileSync(path.join(oldBoard, "untouched"), "utf8")).toBe("older original");
    expect(fs.readFileSync(marker, "utf8")).toBe("old marker bytes");
    // 옛 state의 손상 행이 sanitizer에서 빠져도 새 빈 저장소로 덮지 않는다.
    fs.rmSync(oldArchive); fs.rmSync(oldBoard, { recursive: true });
    const oldState = JSON.stringify({ ...legacy.source, operations: [{ id: "unreadable", theaterId: "t1" }] });
    fs.writeFileSync(legacy.stateFile, oldState);
    expect(legacy.open().load().objectiveRecords).toEqual([]);
    expect(fs.existsSync(legacy.destination)).toBe(false);
    expect(fs.readFileSync(legacy.stateFile, "utf8")).toBe(oldState);
  });

  it("does not restore Commodore aliases as Theater properties, including deletion snapshots", () => {
    const theater = { id: "t1", path: "/work/proj", realpath: "/work/proj", label: "proj", registeredAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-02T00:00:00.000Z", order: 2 };
    const state = sanitizeDurableConsoleState({ version: 6, theaters: [{ ...theater, alias: "Flagship" }], deletionTombstones: [
      { deletionId: "d1", kind: "theater", targetId: "t1", deletedAt: 1, expiresAt: 2, theater: { ...theater, alias: "Old name" }, objectiveRecords: [], groups: [] },
    ] });
    expect(state.theaters).toEqual([theater]);
    expect(state.deletionTombstones?.[0]).toMatchObject({ theater });
    expect(JSON.stringify(state)).not.toContain('"alias"');
  });

  it("reads the on-disk version and preserves the first v3 backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-durable-state-")); tempDirs.push(dir);
    const stateFile = path.join(dir, "state.json"), backupFile = `${stateFile}.v3-backup`;
    const original = '{"version":3,"objectives":[]}\n'; fs.writeFileSync(stateFile, original);
    expect(readDurableStateVersion(stateFile)).toBe(3); backupDurableStateV3(stateFile);
    expect(fs.readFileSync(backupFile, "utf8")).toBe(original);
    fs.writeFileSync(stateFile, '{"version":4,"objectives":[]}\n'); backupDurableStateV3(stateFile);
    expect(fs.readFileSync(backupFile, "utf8")).toBe(original);
    expect(readDurableStateVersion(stateFile)).toBe(4);
    expect(readDurableStateVersion(path.join(dir, "missing.json"))).toBeNull();
  });
});
