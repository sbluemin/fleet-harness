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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  logRawPassthroughBody,
  setWireLogTarget,
  wireLog,
  wireLogEnabled,
} from "../../src/transport/wire-log.js";

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

  it("treats null as forced Off even when the environment target is set", () => {
    const filePath = path.join(temporaryDirectory(), "environment.jsonl");
    process.env.FLEET_GATEWAY_WIRE_LOG = filePath;
    setWireLogTarget(null);

    expect(wireLogEnabled()).toBe(false);
    wireLog("ignored.event", {});
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("managed wire log files", () => {

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
});

async function passthroughChunks(
  chunks: readonly Uint8Array[],
  options: { readonly label: string; readonly contentType?: string | null },
): Promise<Uint8Array[]> {
  const output: Uint8Array[] = [];
  for await (const chunk of logRawPassthroughBody(
    (async function* () {
      yield* chunks;
    })(),
    options,
  )) {
    output.push(chunk);
  }
  return output;
}
