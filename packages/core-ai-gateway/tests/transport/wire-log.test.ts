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

describe("passthrough raw event tap", () => {
  it("is a pure pass-through with no parsing when the wire log is off", async () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const chunk = new TextEncoder().encode('data: {"type":"message_start"}\n\n');
      const output = await passthroughChunks([chunk], {
        label: "off.wire.event",
        contentType: "text/event-stream",
      });
      // Original chunk references flow through untouched — no buffering, no re-chunking.
      expect(output).toEqual([chunk]);
      expect(output[0]).toBe(chunk);
    } finally {
      parseSpy.mockRestore();
    }
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("records an SSE data frame split across network chunks exactly once", async () => {
    const filePath = path.join(temporaryDirectory(), "split.jsonl");
    setWireLogTarget({ path: filePath });
    const frame = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n';
    const cut = 37;
    const output = await passthroughChunks([
      new TextEncoder().encode(frame.slice(0, cut)),
      new TextEncoder().encode(frame.slice(cut)),
    ], { label: "test.wire.event", contentType: "text/event-stream" });

    // Downstream bytes are the original chunks in order.
    expect(new TextDecoder().decode(Buffer.concat(output))).toBe(frame);
    const entries = readLines(filePath).filter((entry) => entry.event === "test.wire.event");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({
      event: "message_start",
      data: { type: "message_start", message: { id: "m1" } },
    });
  });

  it("skips an oversized frame's diagnostic and keeps recording later frames", async () => {
    const filePath = path.join(temporaryDirectory(), "oversized.jsonl");
    setWireLogTarget({ path: filePath });
    // Frame exceeds the 1 MiB diagnostic cap in encoded bytes.
    const oversized = `data: ${JSON.stringify({ type: "message_start", padding: "x".repeat(1024 * 1024) })}\n\n`;
    const normal = 'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n';
    const encoder = new TextEncoder();
    const output = await passthroughChunks([
      encoder.encode(oversized),
      encoder.encode(normal),
    ], { label: "oversized.wire.event", contentType: "text/event-stream" });

    expect(new TextDecoder().decode(Buffer.concat(output))).toBe(oversized + normal);
    const entries = readLines(filePath).filter((entry) => entry.event === "oversized.wire.event");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({
      data: { type: "content_block_delta", delta: { text: "ok" } },
    });
  });

  it("records one non-streaming JSON envelope while preserving its original chunks", async () => {
    const filePath = path.join(temporaryDirectory(), "json.jsonl");
    setWireLogTarget({ path: filePath });
    const first = new TextEncoder().encode('{"type":"message","content":');
    const second = new TextEncoder().encode('[{"type":"text","text":"done"}]}');

    const output = await passthroughChunks([first, second], {
      label: "json.wire.event",
      contentType: "application/json; charset=utf-8",
    });

    expect(output).toEqual([first, second]);
    expect(readLines(filePath).filter((entry) => entry.event === "json.wire.event"))
      .toEqual([expect.objectContaining({
        payload: {
          data: { type: "message", content: [{ type: "text", text: "done" }] },
        },
      })]);
  });

  it.each([
    ["malformed SSE", "text/event-stream", 'event: message_start\ndata: {not-json}\n\n'],
    ["malformed JSON", "application/json", '{not-json}'],
    ["unsupported content type", "text/plain", '{"type":"message"}'],
  ])("keeps %s byte-for-byte and writes no raw event", async (_case, contentType, input) => {
    const filePath = path.join(temporaryDirectory(), "unchanged.jsonl");
    setWireLogTarget({ path: filePath });
    const chunk = new TextEncoder().encode(input);

    const output = await passthroughChunks([chunk], {
      label: "unchanged.wire.event",
      contentType,
    });

    expect(output).toEqual([chunk]);
    expect(existsSync(filePath)).toBe(false);
  });

  it("accounts the cap in encoded bytes, not string length", async () => {
    const filePath = path.join(temporaryDirectory(), "multibyte.jsonl");
    setWireLogTarget({ path: filePath });
    // A multibyte payload whose char count is far under 1 MiB is still bounded by the byte cap
    // (each `가` encodes to three bytes), and a byte-level split inside a multibyte char across
    // chunks is reassembled correctly by the byte buffering.
    const padding = "가".repeat(350 * 1024);
    const oversized = `data: ${JSON.stringify({ type: "message_start", padding })}\n\n`;
    const normal = 'data: {"type":"message_stop"}\n\n';
    const encoder = new TextEncoder();
    const oversizedBytes = encoder.encode(oversized);
    const cut = 700 * 1024;
    const output = await passthroughChunks([
      oversizedBytes.slice(0, cut),
      oversizedBytes.slice(cut),
      encoder.encode(normal),
    ], { label: "multibyte.wire.event", contentType: "text/event-stream" });

    expect(new TextDecoder().decode(Buffer.concat(output))).toBe(oversized + normal);
    const entries = readLines(filePath).filter((entry) => entry.event === "multibyte.wire.event");
    // The oversized frame is skipped; the trailing normal frame is still recorded.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({ data: { type: "message_stop" } });
  });
});
