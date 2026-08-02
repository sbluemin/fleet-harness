import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyCaptures } from "../core/host/legacy-capture-migration.js";
import type { OperationNode } from "../core/host/operations/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("migrateLegacyCaptures", () => {
  it("injects a capture file into payload when providerSession is missing", () => {
    const { consoleDataDir, operations, get, patchCalls } = createHarness([
      makeOperation("op-a", {}),
    ]);
    writeCapture(consoleDataDir, "op-a", {
      provider: "claude",
      sessionId: "provider-session-secret",
      transcriptPath: "/secret/transcript.jsonl",
      source: "startup",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    migrateLegacyCaptures({ consoleDataDir, operations });

    expect(patchCalls).toHaveLength(1);
    expect(get("op-a")?.payload.providerSession).toEqual({
      provider: "claude",
      sessionId: "provider-session-secret",
      transcriptPath: "/secret/transcript.jsonl",
      source: "startup",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });
    expect(fs.existsSync(path.join(consoleDataDir, "captures"))).toBe(false);
  });

  it("does not overwrite an existing payload providerSession", () => {
    const existing = {
      provider: "codex" as const,
      sessionId: "already-in-payload",
      capturedAt: "2026-06-15T00:00:00.000Z",
    };
    const { consoleDataDir, operations, get, patchCalls } = createHarness([
      makeOperation("op-a", { providerSession: existing }),
    ]);
    writeCapture(consoleDataDir, "op-a", {
      provider: "claude",
      sessionId: "from-file",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    migrateLegacyCaptures({ consoleDataDir, operations });

    expect(patchCalls).toHaveLength(0);
    expect(get("op-a")?.payload.providerSession).toEqual(existing);
    expect(fs.existsSync(path.join(consoleDataDir, "captures"))).toBe(false);
  });

  it("deletes orphan capture files without injecting payload", () => {
    const { consoleDataDir, operations, patchCalls } = createHarness([]);
    writeCapture(consoleDataDir, "orphan-op", {
      provider: "claude",
      sessionId: "orphan-session",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    migrateLegacyCaptures({ consoleDataDir, operations });

    expect(patchCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(consoleDataDir, "captures"))).toBe(false);
  });

  it("removes the captures directory even when no files need migration", () => {
    const consoleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-legacy-capture-empty-"));
    tempDirs.push(consoleDataDir);
    fs.mkdirSync(path.join(consoleDataDir, "captures"), { recursive: true });

    migrateLegacyCaptures({
      consoleDataDir,
      operations: {
        get: () => null,
        patch: () => null,
      },
    });

    expect(fs.existsSync(path.join(consoleDataDir, "captures"))).toBe(false);
  });

  it("keeps captures/ when save throws after a successful in-memory migration", () => {
    const { consoleDataDir, operations, get } = createHarness([
      makeOperation("op-a", {}),
    ]);
    writeCapture(consoleDataDir, "op-a", {
      provider: "claude",
      sessionId: "provider-session-secret",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });
    const saveCalls: number[] = [];

    migrateLegacyCaptures({
      consoleDataDir,
      operations,
      save: () => {
        saveCalls.push(1);
        throw new Error("disk full");
      },
    });

    expect(saveCalls).toHaveLength(1);
    expect(get("op-a")?.payload.providerSession).toMatchObject({ sessionId: "provider-session-secret" });
    expect(fs.existsSync(path.join(consoleDataDir, "captures", "op-a.json"))).toBe(true);
  });

  it("deletes captures/ without calling save when nothing was migrated", () => {
    const { consoleDataDir, operations } = createHarness([]);
    writeCapture(consoleDataDir, "orphan-op", {
      provider: "claude",
      sessionId: "orphan-session",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });
    let saveCalled = false;

    migrateLegacyCaptures({
      consoleDataDir,
      operations,
      save: () => {
        saveCalled = true;
      },
    });

    expect(saveCalled).toBe(false);
    expect(fs.existsSync(path.join(consoleDataDir, "captures"))).toBe(false);
  });

  it("no-ops when consoleDataDir is not an absolute path", () => {
    const absoluteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-legacy-capture-relative-"));
    tempDirs.push(absoluteRoot);
    const previousCwd = process.cwd();
    process.chdir(absoluteRoot);
    try {
      fs.mkdirSync("captures", { recursive: true });
      fs.writeFileSync(path.join("captures", "op-a.json"), JSON.stringify({
        provider: "claude",
        sessionId: "provider-session-secret",
        capturedAt: "2026-06-16T00:00:00.000Z",
      }));
      const operations = {
        get: () => makeOperation("op-a", {}),
        patch: () => null,
      };

      migrateLegacyCaptures({ consoleDataDir: "relative-console", operations });

      expect(fs.existsSync(path.join(absoluteRoot, "captures", "op-a.json"))).toBe(true);
      expect(fs.existsSync(path.join(absoluteRoot, "relative-console"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("retains captures/ for a tombstoned operation missing providerSession", () => {
    const { consoleDataDir, operations, patchCalls } = createHarness([]);
    writeCapture(consoleDataDir, "op-deferred", {
      provider: "claude",
      sessionId: "provider-session-secret",
      transcriptPath: "/secret/transcript.jsonl",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    migrateLegacyCaptures({
      consoleDataDir,
      operations,
      tombstonedOperations: [makeOperation("op-deferred", {})],
    });

    expect(patchCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(consoleDataDir, "captures", "op-deferred.json"))).toBe(true);
  });

  it("deletes captures/ when a tombstoned operation already has providerSession", () => {
    const { consoleDataDir, operations, patchCalls } = createHarness([]);
    writeCapture(consoleDataDir, "op-deferred", {
      provider: "claude",
      sessionId: "from-file",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    migrateLegacyCaptures({
      consoleDataDir,
      operations,
      tombstonedOperations: [makeOperation("op-deferred", {
        providerSession: {
          provider: "claude",
          sessionId: "already-in-tombstone",
          capturedAt: "2026-06-15T00:00:00.000Z",
        },
      })],
    });

    expect(patchCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(consoleDataDir, "captures"))).toBe(false);
  });

  it("retains captures/ for operations nested in a theater tombstone", () => {
    const { consoleDataDir, operations, patchCalls } = createHarness([]);
    writeCapture(consoleDataDir, "op-theater-child", {
      provider: "codex",
      sessionId: "provider-session-secret",
      transcriptPath: "/secret/transcript.jsonl",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    migrateLegacyCaptures({
      consoleDataDir,
      operations,
      // theater tombstone의 operations 배열을 flatten한 결과와 동일하게 전달한다.
      tombstonedOperations: [makeOperation("op-theater-child", {})],
    });

    expect(patchCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(consoleDataDir, "captures", "op-theater-child.json"))).toBe(true);
  });

  it("retains captures/ when a single file fails to migrate", () => {
    const { consoleDataDir, operations, get } = createHarness([
      makeOperation("op-a", {}),
      makeOperation("op-broken", {}),
    ]);
    writeCapture(consoleDataDir, "op-a", {
      provider: "claude",
      sessionId: "provider-session-secret",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });
    // 손상 JSON은 파싱에서 throw되어 per-file catch로 떨어진다.
    fs.writeFileSync(path.join(consoleDataDir, "captures", "op-broken.json"), "{ not json");

    migrateLegacyCaptures({ consoleDataDir, operations });

    expect(get("op-a")?.payload.providerSession).toBeDefined();
    expect(fs.existsSync(path.join(consoleDataDir, "captures", "op-broken.json"))).toBe(true);
  });

  it("retains the captures path when directory enumeration fails", () => {
    const { consoleDataDir, operations, patchCalls } = createHarness([]);
    // captures가 디렉터리가 아니면 readdirSync가 ENOTDIR로 throw한다 — 목록을 전혀 못 읽은 경우다.
    const capturesPath = path.join(consoleDataDir, "captures");
    fs.writeFileSync(capturesPath, "not a directory");

    migrateLegacyCaptures({ consoleDataDir, operations });

    expect(patchCalls).toHaveLength(0);
    expect(fs.existsSync(capturesPath)).toBe(true);
  });
});

function createHarness(initial: OperationNode[]) {
  const consoleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-legacy-capture-"));
  tempDirs.push(consoleDataDir);
  const nodes = new Map(initial.map((node) => [node.id, node]));
  const patchCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const operations = {
    get: (id: string) => nodes.get(id) ?? null,
    patch: (id: string, input: { readonly payload?: Record<string, unknown> }) => {
      const current = nodes.get(id);
      if (!current || !input.payload) return null;
      patchCalls.push({ id, payload: input.payload });
      const updated = { ...current, payload: input.payload };
      nodes.set(id, updated);
      return updated;
    },
  };
  return {
    consoleDataDir,
    operations,
    patchCalls,
    get: (id: string) => nodes.get(id) ?? null,
  };
}

function makeOperation(id: string, payload: Record<string, unknown>): OperationNode {
  return {
    id,
    theaterId: "theater",
    pluginId: "terminal",
    type: "agent",
    title: id,
    geometry: null,
    payload,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

function writeCapture(consoleDataDir: string, operationId: string, value: Record<string, unknown>): void {
  const capturesDir = path.join(consoleDataDir, "captures");
  fs.mkdirSync(capturesDir, { recursive: true });
  fs.writeFileSync(path.join(capturesDir, `${operationId}.json`), `${JSON.stringify(value)}\n`);
}
