import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { takeConsoleResumePort } from "../core/host/server.js";
import {
  CONSOLE_UPDATE_OUTCOME_TTL_MS,
  CONSOLE_UPDATE_PROGRESS_STALE_MS,
  consoleUpdateProgressPath,
  readConsoleUpdateProgress,
  writeConsoleUpdateProgress,
  type ConsoleUpdateProgressRecord,
} from "../core/host/update-progress.js";

const dirs: string[] = [];
/** 기록이 남은 직후의 시각. 결과에도 시효가 있으므로 판정 시각을 고정해야 뜻이 고정된다. */
const JUST_AFTER = Date.parse("2026-08-19T00:01:00.000Z");

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-progress-"));
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<ConsoleUpdateProgressRecord> = {}): ConsoleUpdateProgressRecord {
  return {
    phase: "installing",
    startedAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:05.000Z",
    fromVersion: "1.0.0",
    targetVersion: "1.1.0",
    ...overrides,
  };
}

describe("console update progress", () => {

  it("treats an unreadable or malformed record as no update rather than a failure", () => {
    const dir = makeDir();
    fs.writeFileSync(consoleUpdateProgressPath(dir), "{ not json");

    expect(readConsoleUpdateProgress(dir)).toEqual({ state: "idle" });
  });
});

describe("console resume port", () => {
  it("reads the one-shot port and removes it, so a later restart is not pinned to an old address", () => {
    const env: NodeJS.ProcessEnv = { FLEET_CONSOLE_RESUME_PORT: "51530" };

    expect(takeConsoleResumePort(env)).toBe(51530);
    expect(env.FLEET_CONSOLE_RESUME_PORT).toBeUndefined();
    expect(takeConsoleResumePort(env)).toBeNull();
  });
});
