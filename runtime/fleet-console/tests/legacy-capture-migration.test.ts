import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyCaptures } from "../core/host/legacy-capture-migration.js";
import type { OperationNode } from "../core/host/operations/operations-domain.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("migrateLegacyCaptures", () => {

  it("does not overwrite an existing removed-provider payload session", () => {
    const existing = {
      harness: "claude-code" as const,
      id: "already-in-payload",
      capturedAt: "2026-06-15T00:00:00.000Z",
    };
    const { consoleDataDir, operations, get, patchCalls } = createHarness([
      makeOperation("op-a", { session: existing }),
    ]);
    writeCapture(consoleDataDir, "op-a", {
      harness: "claude-code",
      id: "from-file",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    migrateLegacyCaptures({ consoleDataDir, operations });

    expect(patchCalls).toHaveLength(0);
    expect(get("op-a")?.payload.session).toEqual(existing);
    expect(fs.existsSync(path.join(consoleDataDir, "captures"))).toBe(false);
  });

  it("keeps captures/ when save throws after a successful in-memory migration", () => {
    const { consoleDataDir, operations, get } = createHarness([
      makeOperation("op-a", {}),
    ]);
    writeCapture(consoleDataDir, "op-a", {
      harness: "claude-code",
      id: "provider-session-secret",
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
    expect(get("op-a")?.payload.session).toMatchObject({ id: "provider-session-secret" });
    expect(fs.existsSync(path.join(consoleDataDir, "captures", "op-a.json"))).toBe(true);
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
    restore: (node: OperationNode) => nodes.set(node.id, node),
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
