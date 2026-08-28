import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  backupDurableStateV3,
  createConsoleDurableStateStore,
  readDurableStateVersion,
  sanitizeDurableConsoleState,
} from "../core/host/durable-state.js";
import type { ConsoleDataPaths } from "../core/host/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable console state", () => {
  it("falls back to an empty state for version mismatch or malformed data", () => {
    expect(sanitizeDurableConsoleState({ version: 1, theaters: [], operations: [] })).toEqual({ version: 4, theaters: [], operations: [], groups: [], deletionTombstones: [] });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ id: "" }], operations: [{ id: "" }] })).toEqual({ version: 4, theaters: [], operations: [], groups: [], deletionTombstones: [] });
  });

  it("drops legacy pathContext values without changing durable version", () => {
    const base = { id: "t", path: "/work/proj", realpath: "/work/proj", label: "proj", registeredAt: "1", lastOpenedAt: "2" };
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ ...base, pathContext: "packages/core" }], operations: [] })).toMatchObject({ version: 4, theaters: [base] });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ ...base, pathContext: "../escape" }], operations: [] })).toMatchObject({ version: 4, theaters: [base] });
  });

  it("round-trips optional Theater order without changing durable version", () => {
    const base = { id: "t", path: "/work/proj", realpath: "/work/proj", label: "proj", registeredAt: "1", lastOpenedAt: "2" };

    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ ...base, order: 3 }], operations: [] })).toMatchObject({
      version: 4,
      theaters: [{ ...base, order: 3 }],
    });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ ...base, order: -1 }], operations: [] })).toMatchObject({
      version: 4,
      theaters: [base],
    });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ ...base, order: 1.5 }], operations: [] })).toMatchObject({
      version: 4,
      theaters: [base],
    });
  });

  it("migrates v1 flat session records into v2 OperationNodes", () => {
    const migrated = sanitizeDurableConsoleState({
      version: 1,
      theaters: [
        { id: "t1", path: "/work/proj", realpath: "/work/proj", label: "proj", registeredAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-02T00:00:00.000Z" },
      ],
      operations: [
        {
          sessionId: "sess-1",
          theaterId: "t1",
          cwd: "/work/proj",
          cwdLabel: "proj",
          sequence: 7,
          label: "My Session",
          labelSource: "user",
          autoNamePromptSeen: true,
          cliId: "claude",
          cliLabel: "Claude",
          createdAt: 1000,
          providerSession: { provider: "claude", sessionId: "p-1", transcriptPath: "/t.jsonl", capturedAt: "2026-01-01T00:00:00.000Z" },
        },
        // label 없는 v1 op → title은 cwd basename(#N 없음), provider 없는 세션도 패널로 복원
        { sessionId: "sess-2", theaterId: "t1", cwd: "/work/proj/sub", cwdLabel: "sub", sequence: 8, cliId: "codex", cliLabel: "Codex", createdAt: 2000 },
      ],
    });

    expect(migrated.version).toBe(4);
    expect(migrated.theaters).toHaveLength(1);
    expect(migrated.groups).toEqual([]);
    expect(migrated.operations).toEqual([
      {
        id: "sess-1",
        theaterId: "t1",
        type: "agent",
        pluginId: "terminal",
        title: "My Session",
        payload: { cwd: "/work/proj", labelSource: "user", session: { harness: "claude-code", id: "p-1", transcriptPath: "/t.jsonl", capturedAt: "2026-01-01T00:00:00.000Z" } },
        geometry: null,
        ts: { createdAt: 1000, updatedAt: 1000 },
      },
      {
        id: "sess-2",
        theaterId: "t1",
        type: "agent",
        pluginId: "terminal",
        title: "sub",
        payload: { cwd: "/work/proj/sub", session: { harness: "claude-code" } },
        geometry: null,
        ts: { createdAt: 2000, updatedAt: 2000 },
      },
    ]);
  });

  it("remaps persisted terminal plugin ids and drops Shell nodes that are no longer Operations", () => {
    const sanitized = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [
        makeOperationNode({ id: "agent-op", pluginId: "agent", type: "agent" }),
        makeOperationNode({ id: "shell-op", pluginId: "shell", type: "shell" }),
        makeOperationNode({ id: "demo-op", pluginId: "demo", type: "demo" }),
      ],
    });

    expect(sanitized.operations.map((operation) => ({
      id: operation.id,
      pluginId: operation.pluginId,
      type: operation.type,
    }))).toEqual([
      { id: "agent-op", pluginId: "terminal", type: "agent" },
      // Shell은 확대 표면으로 옮겨 갔다 — 옛 상태 파일의 Shell 노드는 그릴 종류가 없어
      // 복원되지 않는다(남기면 렌더러 없는 패널이 캔버스에 선다).
      { id: "demo-op", pluginId: "demo", type: "demo" },
    ]);
  });

  it("migrates v2 to v3 and sanitizes tombstones item by item", () => {
    const theater = { id: "t", path: "/work/proj", realpath: "/work/proj", label: "proj", registeredAt: "1", lastOpenedAt: "2" };
    const operation = makeOperationNode({ id: "op", pluginId: "terminal", type: "agent" });
    const theaterOperation = { ...operation, theaterId: theater.id };
    const sanitized = sanitizeDurableConsoleState({
      version: 4,
      theaters: [],
      operations: [],
      groups: [],
      deletionTombstones: [
        { deletionId: "d-op", targetId: "op", deletedAt: 1, expiresAt: 2, kind: "operation", operation },
        { deletionId: "d-theater", targetId: "t", deletedAt: 3, expiresAt: 4, kind: "theater", theater, operations: [theaterOperation], groups: [] },
        { deletionId: "bad-theater", targetId: "t", deletedAt: 3, expiresAt: 4, kind: "theater", theater, operations: [theaterOperation, { id: "" }], groups: [] },
        { deletionId: "", targetId: "bad", deletedAt: 1, expiresAt: 2, kind: "operation", operation },
        { deletionId: "bad-number", targetId: "bad", deletedAt: Number.NaN, expiresAt: 2, kind: "operation", operation },
      ],
    });

    expect(sanitizeDurableConsoleState({ version: 2, theaters: [theater], operations: [operation], groups: [] })).toMatchObject({
      version: 4,
      deletionTombstones: [],
    });
    expect(sanitized.deletionTombstones).toEqual([
      expect.objectContaining({ deletionId: "d-op", kind: "operation", targetId: "op" }),
      expect.objectContaining({ deletionId: "d-theater", kind: "theater", targetId: "t", operations: [expect.objectContaining({ id: "op" })] }),
    ]);
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

  it("creates the state store with sensitive durable JSON settings", () => {
    let received: unknown;
    const paths: ConsoleDataPaths = {
      dir: "/tmp/fleet/console",
      stateFile: "/tmp/fleet/console/state.json",
      settingsFile: "/tmp/fleet/console/settings.json",
    };

    const store = createConsoleDurableStateStore({
      paths,
      createStore: (deps) => {
        received = deps;
        return {
          path: deps.filePath,
          load: () => deps.sanitize(undefined),
          save: () => undefined,
          update: (mutate) => mutate(deps.sanitize(undefined)) ?? deps.sanitize(undefined),
        };
      },
    });

    expect(store.path).toBe(paths.stateFile);
    expect(received).toMatchObject({
      filePath: paths.stateFile,
      lockDir: path.join(paths.dir, "state.lock"),
      sensitivity: "sensitive",
      tempCleanupPrefix: ".state.",
    });
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
