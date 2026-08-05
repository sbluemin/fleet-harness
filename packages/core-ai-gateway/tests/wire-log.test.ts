import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setWireLogTarget, wireLog, wireLogEnabled } from "../src/wire-log.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-wire-log-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  setWireLogTarget(undefined);
  delete process.env.FLEET_GATEWAY_WIRE_LOG;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("wire log target", () => {
  it("retains the existing JSONL behavior for an environment-only target", () => {
    const filePath = path.join(temporaryDirectory(), "environment.jsonl");
    process.env.FLEET_GATEWAY_WIRE_LOG = filePath;

    expect(wireLogEnabled()).toBe(true);
    wireLog("environment.event", { value: 1n });

    const [entry] = readLines(filePath);
    expect(entry).toMatchObject({
      event: "environment.event",
      payload: { value: "1" },
    });
    expect(entry?.ts).toEqual(expect.any(String));
  });

  it("prefers an explicit override to the environment target", () => {
    const directory = temporaryDirectory();
    const environmentPath = path.join(directory, "environment.jsonl");
    const overridePath = path.join(directory, "override.jsonl");
    process.env.FLEET_GATEWAY_WIRE_LOG = environmentPath;
    setWireLogTarget({ path: overridePath });

    wireLog("override.event", { selected: true });

    expect(existsSync(environmentPath)).toBe(false);
    expect(readLines(overridePath)[0]).toMatchObject({ event: "override.event" });
  });

  it("treats null as forced Off even when the environment target is set", () => {
    const filePath = path.join(temporaryDirectory(), "environment.jsonl");
    process.env.FLEET_GATEWAY_WIRE_LOG = filePath;
    setWireLogTarget(null);

    expect(wireLogEnabled()).toBe(false);
    wireLog("ignored.event", {});
    expect(existsSync(filePath)).toBe(false);
  });

  it("returns to the environment target when the override becomes undefined", () => {
    const filePath = path.join(temporaryDirectory(), "environment.jsonl");
    process.env.FLEET_GATEWAY_WIRE_LOG = filePath;
    setWireLogTarget(null);
    setWireLogTarget(undefined);

    expect(wireLogEnabled()).toBe(true);
    wireLog("restored.event", {});
    expect(readLines(filePath)[0]).toMatchObject({ event: "restored.event" });
  });
});

describe("managed wire log files", () => {
  it("rotates at maxBytes and retains exactly one backup", () => {
    const directory = temporaryDirectory();
    const filePath = path.join(directory, "managed", "wire-log.jsonl");
    setWireLogTarget({ path: filePath, maxBytes: 256 });

    wireLog("first", { value: "a".repeat(80) });
    wireLog("second", { value: "b".repeat(80) });
    wireLog("third", { value: "c".repeat(80) });

    expect(readLines(filePath)[0]).toMatchObject({ event: "third" });
    expect(readLines(`${filePath}.1`)[0]).toMatchObject({ event: "second" });
    expect(readdirSync(path.dirname(filePath)).sort()).toEqual([
      "wire-log.jsonl",
      "wire-log.jsonl.1",
    ]);
    expect(statSync(filePath).size).toBeLessThanOrEqual(256);
    expect(statSync(`${filePath}.1`).size).toBeLessThanOrEqual(256);
  });

  it("resets tracked size when the target is reapplied", () => {
    const filePath = path.join(temporaryDirectory(), "wire-log.jsonl");
    const target = { path: filePath, maxBytes: 512 };
    setWireLogTarget(target);
    wireLog("initial.event", {});
    writeFileSync(filePath, "x".repeat(500));

    setWireLogTarget(target);
    wireLog("after-reset.event", {});

    expect(readFileSync(`${filePath}.1`, "utf8")).toBe("x".repeat(500));
    expect(readLines(filePath)[0]).toMatchObject({ event: "after-reset.event" });
  });

  it("writes an omission marker instead of an entry larger than maxBytes", () => {
    const filePath = path.join(temporaryDirectory(), "wire-log.jsonl");
    setWireLogTarget({ path: filePath, maxBytes: 200 });

    wireLog("oversized.event", { secret: "do-not-write-".repeat(100) });

    const [entry] = readLines(filePath);
    expect(entry).toMatchObject({
      event: "wire_log.entry_omitted",
      payload: {
        event: "oversized.event",
        bytes: expect.any(Number),
      },
    });
    expect(readFileSync(filePath, "utf8")).not.toContain("do-not-write");
  });

  it("creates the parent directory as 0o700 and the file as 0o600", () => {
    const filePath = path.join(temporaryDirectory(), "private", "wire-log.jsonl");
    setWireLogTarget({ path: filePath, maxBytes: 1_024 });

    wireLog("permissions.event", {});

    expect(statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("does not throw when writing fails", () => {
    const directory = temporaryDirectory();
    const parentFile = path.join(directory, "not-a-directory");
    writeFileSync(parentFile, "occupied");
    chmodSync(parentFile, 0o400);
    setWireLogTarget({ path: path.join(parentFile, "wire-log.jsonl"), maxBytes: 1_024 });

    expect(() => wireLog("failed.event", {})).not.toThrow();
  });
});
