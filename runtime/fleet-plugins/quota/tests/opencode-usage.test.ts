import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeOpencodeGoWindows,
  listOpencodeDatabases,
  resolveOpencodeDataDir,
  scanOpencodeGoWindows,
} from "../server/opencode-usage.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
// 2026-08-05 수요일 12:00:00 UTC
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);

describe("opencode go window math", () => {
  it("sums the rolling five-hour session and resets from its oldest message", () => {
    const result = computeOpencodeGoWindows(
      [
        { ms: NOW - 6 * HOUR, cost: 6 },
        { ms: NOW - 4 * HOUR, cost: 3 },
        { ms: NOW - 1 * HOUR, cost: 3 },
      ],
      undefined,
      NOW,
    );
    const session = result.windows.find((window) => window.id === "session");
    // $6/12 = 50%: 6시간 전 행은 창 밖이다.
    expect(session).toEqual({
      id: "session",
      usedPercent: 50,
      resetsAt: NOW - 4 * HOUR + 5 * HOUR,
      period: {
        durationMs: 5 * HOUR,
        durationBasis: "catalog",
        startsAt: NOW - 4 * HOUR,
        startsAtBasis: "derived",
      },
    });
  });

  it("bounds the weekly window to the UTC Monday week", () => {
    const monday = Date.UTC(2026, 7, 3);
    const result = computeOpencodeGoWindows(
      [
        { ms: monday - 1, cost: 30 },
        { ms: monday + DAY, cost: 15 },
      ],
      undefined,
      NOW,
    );
    const weekly = result.windows.find((window) => window.id === "weekly");
    // 일요일 밤 $30은 지난주다 — 이번 주는 $15/30 = 50%.
    expect(weekly).toEqual({
      id: "weekly",
      usedPercent: 50,
      resetsAt: monday + 7 * DAY,
      period: {
        durationMs: 7 * DAY,
        durationBasis: "catalog",
        startsAt: monday,
        startsAtBasis: "derived",
      },
    });
  });

  it("anchors the monthly cycle to the earliest usage's day of month", () => {
    const anchor = Date.UTC(2026, 4, 20, 9, 30);
    const result = computeOpencodeGoWindows(
      [
        { ms: Date.UTC(2026, 6, 25), cost: 12 },
        { ms: Date.UTC(2026, 7, 4), cost: 18 },
      ],
      anchor,
      NOW,
    );
    const cycle = result.windows.find((window) => window.id === "cycle");
    // 진행 중 주기는 7/20 09:30 ~ 8/20 09:30 — 둘 다 포함되어 $30/60 = 50%.
    expect(cycle).toEqual({
      id: "cycle",
      usedPercent: 50,
      resetsAt: Date.UTC(2026, 7, 20, 9, 30),
      period: {
        durationMs: Date.UTC(2026, 7, 20, 9, 30) - Date.UTC(2026, 6, 20, 9, 30),
        durationBasis: "catalog",
        startsAt: Date.UTC(2026, 6, 20, 9, 30),
        startsAtBasis: "derived",
      },
    });
    expect(result.cycleDays).toBe(31);
  });

  it("clamps a spend above the cap to 100 percent", () => {
    const result = computeOpencodeGoWindows([{ ms: NOW - HOUR, cost: 99 }], undefined, NOW);
    expect(result.windows.find((window) => window.id === "session")?.usedPercent).toBe(100);
  });
});

describe("opencode data directory resolution", () => {
  it("honors OPENCODE_DATA_DIR, then XDG_DATA_HOME, then the default", () => {
    expect(resolveOpencodeDataDir({ OPENCODE_DATA_DIR: "/custom/dir/" }, "/home/u")).toBe("/custom/dir");
    expect(resolveOpencodeDataDir({ XDG_DATA_HOME: "~/xdg" }, "/home/u")).toBe("/home/u/xdg/opencode");
    expect(resolveOpencodeDataDir({}, "/home/u")).toBe("/home/u/.local/share/opencode");
  });
});

describe("opencode usage scan", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-usage-"));
    tempDirs.push(dir);
    return dir;
  }

  it("returns null when the machine has no opencode database", async () => {
    const dir = tempDataDir();
    await expect(scanOpencodeGoWindows({ env: { OPENCODE_DATA_DIR: dir }, now: () => NOW })).resolves.toBeNull();
    expect(listOpencodeDatabases(path.join(dir, "missing"))).toEqual([]);
  });

  it("sums opencode-go assistant costs from every channel database", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = tempDataDir();
    const seed = (file: string, rows: readonly { ms: number; cost: number; providerID: string; role?: string }[]) => {
      const db = new DatabaseSync(path.join(dir, file));
      db.exec("CREATE TABLE message (time_created INTEGER, data TEXT)");
      const insert = db.prepare("INSERT INTO message VALUES (?, ?)");
      for (const row of rows) {
        insert.run(row.ms, JSON.stringify({
          role: row.role ?? "assistant",
          providerID: row.providerID,
          cost: row.cost,
          modelID: "minimax-m3",
        }));
      }
      db.close();
    };
    seed("opencode.db", [
      { ms: NOW - HOUR, cost: 3, providerID: "opencode-go" },
      // Zen 종량제와 user 행은 Go 캡에 포함되지 않는다.
      { ms: NOW - HOUR, cost: 50, providerID: "opencode" },
      { ms: NOW - HOUR, cost: 50, providerID: "opencode-go", role: "user" },
    ]);
    seed("opencode-next.db", [{ ms: NOW - 2 * HOUR, cost: 3, providerID: "opencode-go" }]);
    fs.writeFileSync(path.join(dir, "opencode.db-wal"), "");

    const scan = await scanOpencodeGoWindows({ env: { OPENCODE_DATA_DIR: dir }, now: () => NOW });
    expect(scan?.windows.find((window) => window.id === "session")?.usedPercent).toBe(50);
  });
});
