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
