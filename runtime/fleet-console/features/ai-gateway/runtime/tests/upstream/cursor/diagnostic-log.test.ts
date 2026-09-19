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
