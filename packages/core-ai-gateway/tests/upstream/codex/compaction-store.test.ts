import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createClaudeCodexCompactionStore } from "../../../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "fleet-compact-store-"));
  roots.push(value);
  return value;
}

describe("Claude Codex compaction store", () => {
  it("persists pending, ready, and post-compact summary state across instances", () => {
    let now = 1_000;
    const directory = root();
    const first = createClaudeCodexCompactionStore({ directory, now: () => now });
    first.recordPreCompact({ sessionId: "session-1", trigger: "manual", customInstructions: "keep directive" });
    expect(first.readPending("session-1")).toMatchObject({ trigger: "manual", customInstructions: "keep directive" });
    first.clearPending("session-1");
    expect(first.readPending("session-1")).toBeUndefined();
    first.writeReady("session-1", { binding: "binding-1", encryptedContent: "opaque", summary: "initial" });
    now += 1;
    first.recordPostCompact({ sessionId: "session-1", summary: "authoritative summary" });

    const second = createClaudeCodexCompactionStore({ directory, now: () => now });
    expect(second.readReady("session-1", "binding-1")).toMatchObject({
      binding: "binding-1",
      encryptedContent: "opaque",
      summary: "authoritative summary",
    });
    expect(second.readReady("session-1", "wrong-binding")).toBeUndefined();
  });

  it("expires pending state and bounds the number of stored sessions", () => {
    let now = 0;
    const directory = root();
    const store = createClaudeCodexCompactionStore({ directory, now: () => now });
    store.recordPreCompact({ sessionId: "expired", trigger: "auto" });
    now = 11 * 60_000;
    expect(store.readPending("expired")).toBeUndefined();

    for (let index = 0; index < 40; index += 1) {
      now += 1;
      store.writeReady(`session-${index}`, {
        binding: "binding",
        encryptedContent: `opaque-${index}`,
        summary: `summary-${index}`,
      });
    }
    const raw = JSON.parse(readFileSync(store.path, "utf8"));
    expect(Object.keys(raw.sessions)).toHaveLength(16);
    expect(raw.sessions["session-39"]).toBeDefined();
    expect(raw.sessions["session-0"]).toBeUndefined();
  });

  it("sanitizes malformed state instead of exposing it", () => {
    const directory = root();
    const store = createClaudeCodexCompactionStore({ directory });
    store.writeReady("session-1", { binding: "binding", encryptedContent: "opaque", summary: "summary" });
    expect(store.readReady("session-1", "binding")?.encryptedContent).toBe("opaque");
    store.clear("session-1");
    expect(store.readReady("session-1", "binding")).toBeUndefined();
  });
});
