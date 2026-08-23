import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CursorDiagnosticEvent } from "../../../src/upstream/cursor/native/adapter.js";
import { afterEach, describe, expect, it } from "vitest";

import { createCursorDiagnosticLog } from "../../../src/upstream/cursor/diagnostic-log.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

describe("Cursor diagnostic log", () => {
  it("does not create its directory until an enabled trace writes an event", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"));

    await log.flush();

    await expect(stat(path.dirname(log.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves existing active and backup files untouched without new events", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "ai-gateway");
    const activePath = path.join(directory, "cursor-diagnostics.jsonl");
    const backupPath = `${activePath}.1`;
    await mkdir(directory, { recursive: true });
    await writeFile(activePath, "active evidence\n");
    await writeFile(backupPath, "backup evidence\n");
    const activeBefore = await stat(activePath);
    const backupBefore = await stat(backupPath);

    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"));
    await log.flush();

    expect(await readFile(activePath, "utf8")).toBe("active evidence\n");
    expect(await readFile(backupPath, "utf8")).toBe("backup evidence\n");
    expect((await stat(activePath)).mtimeMs).toBe(activeBefore.mtimeMs);
    expect((await stat(backupPath)).mtimeMs).toBe(backupBefore.mtimeMs);
  });

  it("persists only allowlisted fields with private filesystem permissions", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"));
    const event = diagnosticEvent({
      event: "server.frame",
      model: "grok-4.5",
      wireModel: "cursor-grok-4.5-high",
      requestedEffort: "high",
      frame: "interactionUpdate.toolCallStarted",
      sequence: 1,
      contextTokens: 42_000,
      contextWindow: 256_000,
      argumentRepairCount: 1,
    });
    log.write({
      ...event,
      prompt: "SECRET_PROMPT",
      toolArguments: "SECRET_TOOL_ARGUMENTS",
    } as CursorDiagnosticEvent);
    await log.flush();

    const contents = await readFile(log.path, "utf8");
    expect(JSON.parse(contents)).toEqual(expect.objectContaining({
      event: "server.frame",
      model: "grok-4.5",
      wireModel: "cursor-grok-4.5-high",
      requestedEffort: "high",
      frame: "interactionUpdate.toolCallStarted",
      sequence: 1,
      contextTokens: 42_000,
      contextWindow: 256_000,
      argumentRepairCount: 1,
    }));
    expect(contents).not.toContain("SECRET_PROMPT");
    expect(contents).not.toContain("SECRET_TOOL_ARGUMENTS");
    expect((await stat(path.dirname(log.path))).mode & 0o777).toBe(0o700);
    expect((await stat(log.path)).mode & 0o777).toBe(0o600);
  });

  it("keeps one bounded backup when the active file reaches its limit", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"), { maxBytes: 400 });

    for (let index = 1; index <= 3; index += 1) {
      log.write(diagnosticEvent({
        event: "server.frame",
        frame: `interactionUpdate.${"x".repeat(100)}`,
        sequence: index,
      }));
    }
    await log.flush();

    const active = await readFile(log.path, "utf8");
    const backup = await readFile(log.backupPath, "utf8");
    expect(active.trim().split("\n")).toHaveLength(1);
    expect(backup.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(active).sequence).toBe(3);
    expect(JSON.parse(backup).sequence).toBe(2);
  });

  it("persists semantic stall timeouts for hung Cursor turns", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"));

    log.write(diagnosticEvent({
      event: "transport.semantic_timeout",
      model: "composer-2.5-fast",
      wireModel: "composer-2.5-fast",
      requestedEffort: "high",
      outcome: "semantic_stall_timeout",
    }));
    await log.flush();

    expect(JSON.parse(await readFile(log.path, "utf8"))).toMatchObject({
      event: "transport.semantic_timeout",
      model: "composer-2.5-fast",
      wireModel: "composer-2.5-fast",
      requestedEffort: "high",
      outcome: "semantic_stall_timeout",
    });
  });

  it("persists mid-session model switches without raw session identifiers", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"));

    log.write(diagnosticEvent({
      event: "model.switch",
      model: "grok-4.5",
      wireModel: "cursor-grok-4.5-high",
      previousWireModel: "cursor-grok-4.5-low",
      turn: "prompt",
    }));
    await log.flush();

    const contents = await readFile(log.path, "utf8");
    expect(JSON.parse(contents)).toEqual(expect.objectContaining({
      event: "model.switch",
      model: "grok-4.5",
      wireModel: "cursor-grok-4.5-high",
      previousWireModel: "cursor-grok-4.5-low",
      turn: "prompt",
    }));
    expect(contents).not.toContain("claude-session");
    expect(contents).not.toContain("user_id");
  });

  it("persists payload-free redirect operation diagnostics", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"));

    log.write({
      ...diagnosticEvent({
        event: "exec.redirect.result_written",
        operationSequence: 3,
        adapter: "grep-direct",
      }),
      callId: "SECRET_CALL_ID",
      toolOutput: "SECRET_TOOL_OUTPUT",
    } as CursorDiagnosticEvent);
    await log.flush();

    const contents = await readFile(log.path, "utf8");
    expect(JSON.parse(contents)).toMatchObject({
      event: "exec.redirect.result_written",
      operationSequence: 3,
      adapter: "grep-direct",
    });
    expect(contents).not.toContain("SECRET_");
  });

  it("persists payload-free live bridge lifecycle diagnostics", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(path.join(root, "ai-gateway"));

    log.write({
      ...diagnosticEvent({
        event: "bridge.mismatch",
        outcome: "credential",
        count: 2,
      }),
      apiKey: "SECRET_API_KEY",
      toolOutput: "SECRET_TOOL_OUTPUT",
      conversationId: "SECRET_CONVERSATION",
    } as CursorDiagnosticEvent);
    await log.flush();

    const contents = await readFile(log.path, "utf8");
    expect(JSON.parse(contents)).toMatchObject({
      event: "bridge.mismatch",
      outcome: "credential",
      count: 2,
    });
    expect(contents).not.toContain("SECRET_");
  });
});

function diagnosticEvent(
  fields: Pick<CursorDiagnosticEvent, "event"> & Partial<CursorDiagnosticEvent>,
): CursorDiagnosticEvent {
  return {
    timestamp: "2026-08-01T03:43:30.570Z",
    runId: "cursor-run-test",
    elapsedMs: 210,
    ...fields,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-cursor-diagnostics-"));
  temporaryDirectories.push(directory);
  return directory;
}
