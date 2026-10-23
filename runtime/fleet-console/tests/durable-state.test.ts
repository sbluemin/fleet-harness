import { createObjectiveStorage } from "../features/objectives/host/storage.js";
import { createDurableJsonStore } from "@fleet-console/infra";
import { ensureWorkspaceDirectory } from "@fleet-console/infra/workspace-dir";
import type { DurableConsoleState } from "../features/workspace/host/durable-state.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backupDurableStateV3,
  createConsoleDurableStateStore,
  readDurableStateVersion,
  sanitizeDurableConsoleState,
} from "../features/workspace/host/durable-state.js";
import type { ConsoleDataPaths } from "../core/host/bootstrap/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable console state", () => {
  it("falls back to an empty state for version mismatch or malformed data", () => {
    expect(sanitizeDurableConsoleState({ version: 1, theaters: [], operations: [] })).toEqual({ version: 6, theaters: [], operations: [], groups: [], deletionTombstones: [] });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ id: "" }], operations: [{ id: "" }] })).toEqual({ version: 6, theaters: [], operations: [], groups: [], deletionTombstones: [] });
  });

  it("moves the immediate predecessor as one owner tree and retries failed commits without losing the source", () => {
    const root = path.resolve(".fleet/isolated/durable-tests"); fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, "case-")); tempDirs.push(directory);
    const project = path.join(directory, "project"); fs.mkdirSync(project);
    const stateFile = path.join(directory, "state.json");
    const objectiveRoot = path.join(ensureWorkspaceDirectory(directory, project).path, "objectives");
    const destination = path.join(directory, "commodore/owner/objectives");
    const owner = { theaterId: "t1", workspacePath: project, directory: destination };
    const node = { id: "active", theaterId: "t1", type: "agent", pluginId: null, title: "Active", groupId: "g1", order: 2, accent: "sky", geometry: { x: 1, y: 2, width: 300, height: 200 },
      payload: { cwd: project, userQuestions: true, resumeAvailable: true, session: { harness: "claude-code", id: "resume-id" } },
      childSessions: [{ id: "child", payload: { session: { harness: "claude-code", id: "child-resume" } }, ts: { createdAt: 1, updatedAt: 2 } }], ts: { createdAt: 1, updatedAt: 2 } };
    const source = { version: 6, theaters: [{ id: "t1", path: project, realpath: project, label: "project", registeredAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" }], operations: [node],
      groups: [{ id: "g1", theaterId: "t1", name: "Group", color: "sky", order: 0, createdAt: 1 }] };
    fs.writeFileSync(stateFile, JSON.stringify(source));
    fs.writeFileSync(path.join(directory, "operations-archive.json"), JSON.stringify({ version: 1, revision: 1, entries: [{ archiveId: "a1", archivedAt: 3, operation: { ...node, id: "archived", childSessions: [] } }], deletions: [], events: [] }));
    for (const id of ["active", "archived"]) {
      fs.mkdirSync(path.join(objectiveRoot, id, "shared"), { recursive: true });
      fs.writeFileSync(path.join(objectiveRoot, id, "objective.json"), JSON.stringify({ operationId: id, rank: 10, note: `Board ${id}`, missions: [], addedBy: { kind: "commodore", theaterId: "t1" } }));
      fs.writeFileSync(path.join(objectiveRoot, id, "shared", "proof.txt"), `bytes ${id}`);
    }
    const stateStore = createDurableJsonStore<DurableConsoleState>({ filePath: stateFile, lockDir: null, sensitivity: "sensitive", sanitize: sanitizeDurableConsoleState });
    let connected = false;
    const open = () => createObjectiveStorage({ directory, stateStore, owners: () => connected ? [owner] : [] });
    expect(open().load().operations).toEqual([]);
    expect(fs.readFileSync(stateFile, "utf8")).toBe(JSON.stringify(source));
    connected = true;
    const rename = fs.renameSync.bind(fs);
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === destination) throw new Error("commit_interrupted"); rename(from, to); });
    try { expect(open().load().operations).toEqual([]); } finally { fault.mockRestore(); }
    expect(fs.readFileSync(stateFile, "utf8")).toBe(JSON.stringify(source));
    expect(fs.existsSync(path.join(objectiveRoot, "active", "objective.json"))).toBe(true);
    expect(fs.existsSync(destination)).toBe(false);
    const moved = open(); const state = moved.load();
    expect(state.operations[0]?.payload.session).toEqual({ harness: "claude-code", id: "resume-id" });
    expect(state.operations[0]?.childSessions?.[0]?.payload.session).toEqual({ harness: "claude-code", id: "child-resume" });
    expect(state.groups).toHaveLength(1);
    expect(moved.entries()[0]?.operation.id).toBe("archived");
    expect(moved.board.list("t1").map((board) => board.note).sort()).toEqual(["Board active", "Board archived"]);
    const activeFile = path.join(destination, "active/objective.json");
    expect(JSON.parse(fs.readFileSync(activeFile, "utf8"))).toMatchObject({ id: "active", title: "Active", note: "Board active", session: { id: "resume-id" }, sessions: [{ id: "child" }] });
    expect(fs.readFileSync(path.join(destination, "archived/shared/proof.txt"), "utf8")).toBe("bytes archived");
    expect(fs.existsSync(objectiveRoot)).toBe(false);
    expect(fs.existsSync(path.join(directory, "operations-archive.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).not.toHaveProperty("operations");
    moved.board.save("t1", { ...moved.board.list("t1").find((board) => board.operationId === "active")!, note: "Edited" });
    moved.save(state);
    const restarted = open(); expect(restarted.load().operations).toHaveLength(1);
    expect(restarted.board.list("t1").find((board) => board.operationId === "active")?.note).toBe("Edited");
    expect(restarted.entries()).toHaveLength(1);
  });

  it("keeps a Theater alias across reload and still reads records saved without one", () => {
    const base = { path: "/work/proj", realpath: "/work/proj", label: "proj", registeredAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-02T00:00:00.000Z" };
    const state = sanitizeDurableConsoleState({
      version: 6,
      theaters: [
        { ...base, id: "aliased", alias: "  Flagship  " },
        { ...base, id: "legacy" },
        { ...base, id: "bidi", alias: "abc\u202Egnp.exe" },
        { ...base, id: "oversized", alias: "x".repeat(41) },
      ],
      operations: [],
      groups: [],
      deletionTombstones: [],
    });
    const byId = new Map(state.theaters.map((theater) => [theater.id, theater]));
    expect(byId.get("aliased")?.alias).toBe("Flagship");
    expect(byId.get("legacy")).not.toHaveProperty("alias");
    expect(byId.get("bidi")).not.toHaveProperty("alias");
    expect(byId.get("oversized")).not.toHaveProperty("alias");
  });

  it("reads the on-disk version and preserves the first v3 backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-durable-state-"));
    tempDirs.push(dir);
    const stateFile = path.join(dir, "state.json");
    const backupFile = `${stateFile}.v3-backup`;
    const original = '{"version":3,"operations":[]}\n';
    fs.writeFileSync(stateFile, original);

    expect(readDurableStateVersion(stateFile)).toBe(3);
    backupDurableStateV3(stateFile);
    expect(fs.readFileSync(backupFile, "utf8")).toBe(original);

    fs.writeFileSync(stateFile, '{"version":4,"operations":[]}\n');
    backupDurableStateV3(stateFile);
    expect(fs.readFileSync(backupFile, "utf8")).toBe(original);
    expect(readDurableStateVersion(path.join(dir, "missing.json"))).toBeNull();
  });

});

function makeOperationNode(input: { readonly id: string; readonly pluginId: string; readonly type: string }) {
  return {
    id: input.id,
    theaterId: "theater",
    type: input.type,
    pluginId: input.pluginId,
    title: input.id,
    payload: {},
    geometry: null,
    state: {},
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
