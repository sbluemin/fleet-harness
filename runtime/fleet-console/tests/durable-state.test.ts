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
