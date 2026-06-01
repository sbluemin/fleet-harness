import os from "node:os";
import path from "node:path";
import type { PathLike, RmOptions } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("store lock stale recovery races", () => {
  afterEach(async () => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("restores quarantined locks when the owner identity differs after rename", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const tempDir = actualFs.mkdtempSync(path.join(os.tmpdir(), "fleet-store-lock-race-"));
    const lockDir = path.join(tempDir, "carriers.json.lock");
    const staleOwner = { pid: 999_999, hostname: os.hostname(), startedAt: Date.now() - 60_000 };
    const freshOwner = { pid: process.pid, hostname: os.hostname(), startedAt: Date.now() };
    actualFs.mkdirSync(lockDir);
    actualFs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(staleOwner), "utf-8");

    const renameSync = vi.fn((source: PathLike, target: PathLike) => {
      actualFs.renameSync(source, target);
      if (String(source) === lockDir && String(target).includes(".stale.")) {
        actualFs.writeFileSync(path.join(String(target), "owner.json"), JSON.stringify(freshOwner), "utf-8");
      }
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
      const { initStore, resetStoreForTests, withStoreLock } = await import("../../src/index.js");
      initStore(tempDir);
      let entered = false;
      withStoreLock(() => {
        entered = true;
      });

      expect(entered).toBe(true);
      expect(renameSync).toHaveBeenCalledWith(expect.stringContaining(".stale."), lockDir);
      expect(rmSync).not.toHaveBeenCalledWith(expect.stringContaining(".stale."), expect.anything());
      resetStoreForTests();
    } finally {
      actualFs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
