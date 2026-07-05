// carriers/store-lock-race.test.ts에서 이전 — 락 알고리즘이 fs-store로 이동했으므로
// race/quarantine 복구 단위 테스트를 fs-store directory-lock으로 재작성한다.
import os from "node:os";
import path from "node:path";
import type { PathLike, RmOptions } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("directory-lock stale recovery races", () => {
  afterEach(async () => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("quarantine 후 owner identity가 달라지면 lock을 복원한다", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const tempDir = actualFs.mkdtempSync(path.join(os.tmpdir(), "fleet-dir-lock-race-"));
    const lockDir = path.join(tempDir, "carriers.json.lock");
    const staleOwner = { pid: 999_999, hostname: os.hostname(), startedAt: Date.now() - 60_000 };
    const freshOwner = { pid: process.pid, hostname: os.hostname(), startedAt: Date.now() };
    actualFs.mkdirSync(lockDir);
    actualFs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(staleOwner), "utf-8");

    const renameSync = vi.fn((source: PathLike, target: PathLike) => {
      actualFs.renameSync(source, target);
      // quarantine 이동 직후 owner를 fresh로 교체하여 identity mismatch를 시뮬레이션
      if (String(source) === lockDir && String(target).includes(".stale.")) {
        actualFs.writeFileSync(path.join(String(target), "owner.json"), JSON.stringify(freshOwner), "utf-8");
      }
      // 복원 이동 시 lockDir을 실제로 삭제하여 복원 후 재획득 가능하게
      if (String(source).includes(".stale.") && String(target) === lockDir) {
        actualFs.rmSync(lockDir, { recursive: true, force: true });
      }
    });
    const rmSync = vi.fn((target: PathLike, options?: RmOptions) => {
      actualFs.rmSync(target, options);
    });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      renameSync,
      rmSync,
    }));

    try {
      const { withDirectoryLock } = await import("../../src/fs-store/directory-lock.js");
      let entered = false;
      withDirectoryLock(
        { lockDir, ownerFileName: "owner.json", timeoutMs: 2000, staleLockMs: 1 },
        () => { entered = true; },
      );

      expect(entered).toBe(true);
      // quarantine 경로로 복원 시도가 있었어야 한다
      expect(renameSync).toHaveBeenCalledWith(expect.stringContaining(".stale."), lockDir);
      // stale lock 삭제는 identity 불일치로 호출되지 않아야 한다
      expect(rmSync).not.toHaveBeenCalledWith(expect.stringContaining(".stale."), expect.anything());
    } finally {
      actualFs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stale lock은 복구 후 operation이 실행된다", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const tempDir = actualFs.mkdtempSync(path.join(os.tmpdir(), "fleet-dir-lock-stale-"));
    const lockDir = path.join(tempDir, "test.lock");

    // stale lock 생성 (dead pid, 충분히 오래됨)
    actualFs.mkdirSync(lockDir);
    const staleOwner = { pid: 999_999, hostname: os.hostname(), startedAt: Date.now() - 60_000 };
    actualFs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(staleOwner), "utf-8");

    try {
      const { withDirectoryLock } = await import("../../src/fs-store/directory-lock.js");
      let entered = false;
      withDirectoryLock(
        { lockDir, ownerFileName: "owner.json", timeoutMs: 2000, staleLockMs: 1 },
        () => { entered = true; },
      );
      expect(entered).toBe(true);
    } finally {
      actualFs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
