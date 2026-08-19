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
  it("reports idle when this console has never been updated", () => {
    expect(readConsoleUpdateProgress(makeDir())).toEqual({ state: "idle" });
  });

  it("survives the process that wrote it — a later daemon reads the same fixed name", () => {
    const dir = makeDir();
    writeConsoleUpdateProgress(dir, record({ phase: "completed" }));

    // 이름이 고정이어야 재기동한 데몬이 "방금 무슨 일이 있었는가"를 되물을 수 있다.
    expect(fs.existsSync(consoleUpdateProgressPath(dir))).toBe(true);
    expect(readConsoleUpdateProgress(dir, { now: () => JUST_AFTER })).toEqual({
      state: "completed",
      phase: "completed",
      startedAt: "2026-08-19T00:00:00.000Z",
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
    });
  });

  it("carries the failure reason so the screen can say why instead of just going quiet", () => {
    const dir = makeDir();
    writeConsoleUpdateProgress(dir, record({ phase: "failed", error: "global package install failed" }));

    expect(readConsoleUpdateProgress(dir, { now: () => JUST_AFTER })).toMatchObject({ state: "failed", error: "global package install failed" });
  });

  it("keeps a fresh running record running so the curtain stays down", () => {
    const dir = makeDir();
    const now = Date.parse("2026-08-19T00:00:10.000Z");
    writeConsoleUpdateProgress(dir, record());

    expect(readConsoleUpdateProgress(dir, { now: () => now })).toMatchObject({ state: "running", phase: "installing" });
  });

  it("calls a running record that stopped reporting a failure, so the curtain cannot outlive the worker", () => {
    const dir = makeDir();
    writeConsoleUpdateProgress(dir, record());
    const now = Date.parse("2026-08-19T00:00:05.000Z") + CONSOLE_UPDATE_PROGRESS_STALE_MS + 1;

    expect(readConsoleUpdateProgress(dir, { now: () => now })).toMatchObject({ state: "failed", error: "update_worker_lost" });
  });

  it("stops reporting a finished update once it is no longer news", () => {
    // 다른 기기·다른 브라우저가 몇 주 뒤에 "업데이트되었습니다"를 보게 두지 않는다.
    const dir = makeDir();
    writeConsoleUpdateProgress(dir, record({ phase: "completed", updatedAt: "2026-08-19T00:00:05.000Z" }));
    const later = Date.parse("2026-08-19T00:00:05.000Z") + CONSOLE_UPDATE_OUTCOME_TTL_MS + 1;

    expect(readConsoleUpdateProgress(dir, { now: () => later })).toEqual({ state: "idle" });
  });

  it("treats an unreadable or malformed record as no update rather than a failure", () => {
    const dir = makeDir();
    fs.writeFileSync(consoleUpdateProgressPath(dir), "{ not json");

    expect(readConsoleUpdateProgress(dir)).toEqual({ state: "idle" });
  });

  it("marks the run that could not reclaim its address, because that is the run that opened a new window", () => {
    const dir = makeDir();
    writeConsoleUpdateProgress(dir, record({ phase: "completed", endpointChanged: true }));

    expect(readConsoleUpdateProgress(dir, { now: () => JUST_AFTER })).toMatchObject({ state: "completed", endpointChanged: true });
  });
});

describe("console resume port", () => {
  it("reads the one-shot port and removes it, so a later restart is not pinned to an old address", () => {
    const env: NodeJS.ProcessEnv = { FLEET_CONSOLE_RESUME_PORT: "51530" };

    expect(takeConsoleResumePort(env)).toBe(51530);
    expect(env.FLEET_CONSOLE_RESUME_PORT).toBeUndefined();
    expect(takeConsoleResumePort(env)).toBeNull();
  });

  it("ignores a value that is not a bindable port", () => {
    for (const raw of ["0", "-1", "70000", "not-a-port", ""]) {
      expect(takeConsoleResumePort({ FLEET_CONSOLE_RESUME_PORT: raw })).toBeNull();
    }
  });
});
