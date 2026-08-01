import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CursorDiagnosticEvent } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createCursorDiagnosticLog } from "../server/ai-gateway-diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

describe("Cursor diagnostic log", () => {
  it("persists only allowlisted fields with private filesystem permissions", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(root);
    const event = diagnosticEvent({
      event: "server.frame",
      frame: "interactionUpdate.toolCallStarted",
      sequence: 1,
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
      frame: "interactionUpdate.toolCallStarted",
      sequence: 1,
    }));
    expect(contents).not.toContain("SECRET_PROMPT");
    expect(contents).not.toContain("SECRET_TOOL_ARGUMENTS");
    expect((await stat(path.dirname(log.path))).mode & 0o777).toBe(0o700);
    expect((await stat(log.path)).mode & 0o777).toBe(0o600);
  });

  it("keeps one bounded backup when the active file reaches its limit", async () => {
    const root = await temporaryDirectory();
    const log = createCursorDiagnosticLog(root, { maxBytes: 400 });

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
