import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRecentLogFiles } from "../src/log/index.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

describe("log reader", () => {
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads recent log files through the public log surface", () => {
    const home = mockHome();
    const logsDir = makeLogsDir(home);
    const older = path.join(logsDir, "core-2026-05-24.log");
    const newer = path.join(logsDir, "wiki-2026-05-25.log");
    fs.writeFileSync(older, "old\n", "utf8");
    fs.writeFileSync(newer, "new\n", "utf8");
    fs.utimesSync(older, 1, 1);
    fs.utimesSync(newer, 2, 2);

    expect(readRecentLogFiles({ limit: 2 }).map((file) => file.fileName)).toEqual([
      "wiki-2026-05-25.log",
      "core-2026-05-24.log",
    ]);
    expect(readRecentLogFiles({ category: "core", limit: 2 })).toEqual([
      expect.objectContaining({ category: "core", fileName: "core-2026-05-24.log", lines: ["old"] }),
    ]);
  });

  it("ignores symlinks and non-file log entries", () => {
    const home = mockHome();
    const logsDir = makeLogsDir(home);
    const secret = path.join(home, "secret.txt");
    fs.writeFileSync(secret, "do-not-read\n", "utf8");
    fs.symlinkSync(secret, path.join(logsDir, "core-2026-05-25.log"));
    fs.mkdirSync(path.join(logsDir, "wiki-2026-05-25.log"));

    expect(readRecentLogFiles({ limit: 10 })).toEqual([]);
  });

  it("caps file size and returned line count", () => {
    const home = mockHome();
    const logsDir = makeLogsDir(home);
    const lines = Array.from({ length: 400 }, (_, index) => `line-${index.toString().padStart(3, "0")}-${"x".repeat(1024)}`);
    fs.writeFileSync(path.join(logsDir, "core-2026-05-25.log"), lines.join("\n"), "utf8");

    const [file] = readRecentLogFiles({ limit: 1 });

    expect(file?.truncated).toBe(true);
    expect(file?.lines.length).toBeLessThanOrEqual(200);
    expect(file?.lines.at(-1)).toContain("line-399");
    expect(file?.lines.join("\n")).not.toContain("line-000");
  });

  it("returns no files when the log directory is a symlink", () => {
    const home = mockHome();
    const fleetDir = path.join(home, ".fleet");
    const realLogsDir = path.join(home, "real-logs");
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.mkdirSync(realLogsDir);
    fs.writeFileSync(path.join(realLogsDir, "core-2026-05-25.log"), "outside\n", "utf8");
    fs.symlinkSync(realLogsDir, path.join(fleetDir, "logs"));

    expect(readRecentLogFiles({ limit: 10 })).toEqual([]);
  });
});

function mockHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-log-reader-"));
  tempDirs.push(home);
  process.env.HOME = home;
  return home;
}

function makeLogsDir(home: string): string {
  const logsDir = path.join(home, ".fleet", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}
