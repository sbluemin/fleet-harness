import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testHomeDir = "";

beforeEach(() => {
  testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-core-data-dir-migrate-"));
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      homedir: () => testHomeDir,
    };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  cleanupTestHome();
});

describe("Fleet data directory migration", () => {
  it("moves legacy dir when target does not exist", async () => {
    const legacyDir = path.join(testHomeDir, ".pi", "fleet");
    const dataDir = path.join(testHomeDir, ".fleet");
    fs.mkdirSync(path.join(legacyDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "settings.json"), "{}");

    const { migrateLegacyFleetDataDir } = await import("../../../src/infra/data-dir/migrate.js");
    migrateLegacyFleetDataDir(dataDir);

    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "settings.json"))).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it("recursively moves directories, backs up clashing files", async () => {
    const legacyDir = path.join(testHomeDir, ".pi", "fleet");
    const dataDir = path.join(testHomeDir, ".fleet");
    fs.mkdirSync(path.join(legacyDir, "logs", "archive"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "settings.json"), JSON.stringify({ onlyLegacy: true }));
    fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ onlyCurrent: true }));
    fs.writeFileSync(path.join(legacyDir, "logs", "archive", "old.log"), "old");
    fs.writeFileSync(path.join(dataDir, "logs", "current.log"), "current");
    fs.writeFileSync(path.join(legacyDir, "notes.txt"), "legacy");
    fs.writeFileSync(path.join(dataDir, "notes.txt"), "current");

    const { migrateLegacyFleetDataDir } = await import("../../../src/infra/data-dir/migrate.js");
    migrateLegacyFleetDataDir(dataDir);

    // 충돌 파일은 backup으로 이동, 현재 파일은 유지
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8"))).toEqual({
      onlyCurrent: true,
    });
    expect(fs.readFileSync(path.join(dataDir, "logs", "current.log"), "utf-8")).toBe("current");
    expect(fs.readFileSync(path.join(dataDir, "logs", "archive", "old.log"), "utf-8")).toBe("old");
    expect(fs.readFileSync(path.join(dataDir, "notes.txt"), "utf-8")).toBe("current");
    expect(findBackup(dataDir, "notes.txt")).toBeTruthy();
    expect(findBackup(dataDir, "settings.json")).toBeTruthy();
  });

  it("does not follow symlinked legacy entries during migration", async () => {
    const legacyDir = path.join(testHomeDir, ".pi", "fleet");
    const dataDir = path.join(testHomeDir, ".fleet");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(testHomeDir, "outside.txt"), "outside");
    fs.symlinkSync(path.join(testHomeDir, "outside.txt"), path.join(legacyDir, "linked.txt"));

    const { migrateLegacyFleetDataDir } = await import("../../../src/infra/data-dir/migrate.js");
    migrateLegacyFleetDataDir(dataDir);

    expect(fs.existsSync(path.join(dataDir, "linked.txt"))).toBe(false);
    expect(fs.lstatSync(path.join(legacyDir, "linked.txt")).isSymbolicLink()).toBe(true);
  });

  it("fails closed when the migration lock path is a symlink", async () => {
    const legacyDir = path.join(testHomeDir, ".pi", "fleet");
    const dataDir = path.join(testHomeDir, ".fleet");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(testHomeDir, "outside-lock"), "outside");
    fs.symlinkSync(path.join(testHomeDir, "outside-lock"), path.join(testHomeDir, ".fleet.migration.lock"));

    const { migrateLegacyFleetDataDir } = await import("../../../src/infra/data-dir/migrate.js");

    expect(() => migrateLegacyFleetDataDir(dataDir)).toThrow(/migration lock/i);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("does nothing when legacy dir does not exist", async () => {
    const dataDir = path.join(testHomeDir, ".fleet");

    const { migrateLegacyFleetDataDir } = await import("../../../src/infra/data-dir/migrate.js");
    migrateLegacyFleetDataDir(dataDir);

    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("does nothing when target is a symlink", async () => {
    const legacyDir = path.join(testHomeDir, ".pi", "fleet");
    const dataDir = path.join(testHomeDir, ".fleet");
    const outsideDir = path.join(testHomeDir, "outside-fleet");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, dataDir);

    const { migrateLegacyFleetDataDir } = await import("../../../src/infra/data-dir/migrate.js");
    migrateLegacyFleetDataDir(dataDir);

    expect(fs.existsSync(legacyDir)).toBe(true);
  });
});

function findBackup(dataDir: string, fileName: string): string | undefined {
  return fs.readdirSync(dataDir).find((entry) => entry.startsWith(`${fileName}.legacy-backup-`));
}

function cleanupTestHome(): void {
  try {
    if (testHomeDir.length > 0) {
      fs.rmSync(testHomeDir, { force: true, recursive: true });
    }
  } catch {
    // 테스트 정리 실패 시 무시
  } finally {
    testHomeDir = "";
  }
}
