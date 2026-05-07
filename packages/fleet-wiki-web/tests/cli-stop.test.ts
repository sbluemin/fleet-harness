import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv.slice();
const originalExit = process.exit;
const originalStderrWrite = process.stderr.write;

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  process.argv = ["node", "vitest-stop-test", "--stop"];
  process.exit = vi.fn() as never;
  process.stderr.write = vi.fn() as never;
});

afterEach(() => {
  process.argv = originalArgv.slice();
  process.exit = originalExit;
  process.stderr.write = originalStderrWrite;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("main --stop", () => {
  it("rejects corrupted lock pid without calling kill path", async () => {
    const removeLockFile = vi.fn();
    const isProcessAlive = vi.fn();

    vi.doMock("../src/lock.js", () => ({
      isProcessAlive,
      lockFilePath: vi.fn(() => "/tmp/fleet-wiki-test.lock"),
      readLockFile: vi.fn(async () => ({
        pid: 0,
        port: 3737,
        cwd: process.cwd(),
        startedAt: "2026-05-07T00:00:00.000Z",
      })),
      removeLockFile,
      acquireLockFile: vi.fn(),
      LockExistsError: class LockExistsError extends Error {},
    }));

    const { main } = await import("../src/cli.js");
    await main();

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      "lock에 비정상 PID가 기록되어 있습니다(pid=0). 안전을 위해 종료를 건너뜁니다.\n",
    );
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(removeLockFile).not.toHaveBeenCalled();
  });

  it("removes stale lock when pid is already dead", async () => {
    const removeLockFile = vi.fn(async () => undefined);
    const isProcessAlive = vi.fn(() => false);

    vi.doMock("../src/lock.js", () => ({
      isProcessAlive,
      lockFilePath: vi.fn(() => "/tmp/fleet-wiki-test.lock"),
      readLockFile: vi.fn(async () => ({
        pid: 43210,
        port: 3737,
        cwd: process.cwd(),
        startedAt: "2026-05-07T00:00:00.000Z",
      })),
      removeLockFile,
      acquireLockFile: vi.fn(),
      LockExistsError: class LockExistsError extends Error {},
    }));

    const { main } = await import("../src/cli.js");
    await main();

    expect(process.exit).not.toHaveBeenCalled();
    expect(isProcessAlive).toHaveBeenCalledWith(43210);
    expect(removeLockFile).toHaveBeenCalledWith("/tmp/fleet-wiki-test.lock");
    expect(process.stderr.write).toHaveBeenCalledWith(
      "Fleet Wiki 서버(pid=43210)는 이미 종료되어 있습니다.\n",
    );
  });
});
