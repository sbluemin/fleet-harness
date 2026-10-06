import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { takeConsoleResumePort } from "../core/host/bootstrap/server.js";
import {
  dismissUpdateWatch,
  hydrateUpdateProgress,
  requestConsoleUpdate,
  useUpdateProgress,
  type UpdateProgressSnapshot,
} from "../features/updates/client/update-progress-store.js";
import {
  CONSOLE_UPDATE_OUTCOME_TTL_MS,
  CONSOLE_UPDATE_PROGRESS_STALE_MS,
  consoleUpdateProgressPath,
  readConsoleUpdateProgress,
  writeConsoleUpdateProgress,
  type ConsoleUpdateProgressRecord,
} from "../features/updates/host/update-progress.js";

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
  it("concludes a running update as lost the moment its worker is gone, instead of holding the curtain", () => {
    // Only ESRCH ends a worker: a running record whose worker pid is gone can never move again.
    const dir = makeDir();
    writeConsoleUpdateProgress(dir, record({ workerPid: 4242 }));
    const read = (alive: boolean) => readConsoleUpdateProgress(dir, { now: () => JUST_AFTER, isPidAlive: () => alive });

    expect(read(true).state).toBe("running");
    expect(read(false)).toMatchObject({ state: "failed", reason: "worker-lost" });
  });

  it("treats an unreadable or malformed record as no update rather than a failure", () => {
    const dir = makeDir();
    fs.writeFileSync(consoleUpdateProgressPath(dir), "{ not json");

    expect(readConsoleUpdateProgress(dir)).toEqual({ state: "idle" });
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => { values.clear(); },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function readProgress(): UpdateProgressSnapshot {
  let snapshot: UpdateProgressSnapshot | null = null;
  function Probe(): null {
    snapshot = useUpdateProgress();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (snapshot === null) throw new Error("update progress snapshot was not read");
  return snapshot;
}

describe("a screen waiting before an update is accepted", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  beforeEach(() => {
    session.clear();
    local.clear();
    vi.stubGlobal("window", { sessionStorage: session, localStorage: local });
    vi.stubGlobal("location", { reload() {} });
    dismissUpdateWatch();
  });
  afterEach(() => {
    dismissUpdateWatch();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps preparing until the apply answer, then releases the button after a delegated restart does not arrive", async () => {
    vi.useFakeTimers();
    const description = "The update worker did not finish its checks within 15s. The update did not ask the Console to stop and installed nothing.";
    let resolveApply: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/updates/apply")) return new Promise<Response>((resolve) => { resolveApply = resolve; });
      return Promise.resolve(Response.json({ state: "idle" }));
    });

    const pending = requestConsoleUpdate("1.1.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(readProgress().preparing).toBe("update-preflight");

    resolveApply(new Response(JSON.stringify({
      error: "update_worker_unavailable",
      progress: {
        state: "failed",
        phase: "failed",
        startedAt: "2026-08-19T00:00:00.000Z",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        reason: "preflight-timeout",
        failureStage: "preflight",
        description,
      },
    }), { status: 503, headers: { "Content-Type": "application/json" } }));
    await pending;
    const failed = readProgress();
    expect(failed.preparing).toBeNull();
    expect(failed.outcome).toBe("failed");
    expect(failed.progress?.description).toBe(description);

    const again = requestConsoleUpdate("1.1.0");
    await vi.advanceTimersByTimeAsync(0);
    resolveApply(new Response(JSON.stringify({ status: "delegated" }), { status: 202, headers: { "Content-Type": "application/json" } }));
    await again;
    await vi.advanceTimersByTimeAsync(60_000);
    const released = readProgress();
    expect(released.preparing).toBeNull();
    expect(released.watching).toBe(false);
  });

  it("shows a refreshed tab the preflight wait, then the stop curtain only after preflight, and a timeout without that curtain", async () => {
    vi.useFakeTimers();
    const dir = makeDir();
    const read = () => readConsoleUpdateProgress(dir, { now: () => JUST_AFTER, isPidAlive: () => true });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (!String(input).includes("/api/v1/updates/progress")) throw new Error(String(input));
      return Response.json(read());
    });
    writeConsoleUpdateProgress(dir, record({ phase: "starting", workerPid: process.pid }));

    hydrateUpdateProgress();
    await vi.advanceTimersByTimeAsync(0);
    // 옛 hydrate는 이 키에 stopping을 써서 정지 커튼을 연다. 준비 중에는 그 키가 없어야 한다.
    expect(session.getItem("fleet-console.update.stage")).toBeNull();
    expect(readProgress().preparing).toBe("update-preflight");
    expect(readProgress().watching).toBe(false);

    writeConsoleUpdateProgress(dir, record({ phase: "preflight-ok", workerPid: process.pid }));
    await vi.advanceTimersByTimeAsync(1_500);
    const accepted = readProgress();
    expect(accepted.watching).toBe(true);
    expect(accepted.stage).toBe("stopping");
    expect(accepted.preparing).toBeNull();

    dismissUpdateWatch();
    session.clear();
    writeConsoleUpdateProgress(dir, record({ phase: "starting", workerPid: process.pid, updatedAt: "2026-08-19T00:00:10.000Z" }));
    hydrateUpdateProgress();
    await vi.advanceTimersByTimeAsync(0);
    expect(readProgress().watching).toBe(false);
    expect(readProgress().preparing).toBe("update-preflight");

    writeConsoleUpdateProgress(dir, record({
      phase: "failed",
      reason: "preflight-timeout",
      failureStage: "preflight",
      error: "preflight_timeout",
      workerPid: process.pid,
      updatedAt: "2026-08-19T00:00:20.000Z",
    }));
    await vi.advanceTimersByTimeAsync(1_500);
    const timedOut = readProgress();
    expect(timedOut.outcome).toBe("failed");
    expect(timedOut.progress?.reason).toBe("preflight-timeout");
    expect(timedOut.watching).toBe(false);
    expect(session.getItem("fleet-console.update.stage")).toBeNull();
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
