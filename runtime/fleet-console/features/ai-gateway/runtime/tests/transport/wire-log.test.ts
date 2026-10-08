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
  type PassthroughWireLogOptions,
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
  options: PassthroughWireLogOptions,
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

function sseBytes(events: readonly Record<string, unknown>[]): Uint8Array {
  return new TextEncoder().encode(
    events.map((data) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
  );
}

/** Splits at odd byte offsets so frames and multi-byte characters straddle chunks. */
function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

function toolUseEvents(messageId: string, toolUseId: string, parts: readonly string[]): Record<string, unknown>[] {
  return [
    { type: "message_start", message: { id: messageId, model: "claude-test" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolUseId, name: "write_note", input: {} } },
    ...parts.map((part) => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: part } })),
  ];
}

describe("passthrough tool input records", () => {
  it("keeps each streamed tool input with its session correlation after the main log rotates past it", async () => {
    const directory = temporaryDirectory();
    const mainPath = path.join(directory, "wire-log.jsonl");
    const toolInputPath = path.join(directory, "wire-tool-inputs.jsonl");
    setWireLogTarget({ path: mainPath, maxBytes: 2_000, toolInputs: { path: toolInputPath, maxBytes: 64 * 1024 } });
    // Synthetic Hangul split between deltas: the record must hold the provider's text, not a re-encoding.
    const parts = ['{"text":"한', '글 입', '력","n":1}'];
    const completed = sseBytes([
      ...toolUseEvents("msg_complete", "toolu_complete", parts),
      { type: "content_block_stop", index: 1 },
      ...Array.from({ length: 40 }, () => ({
        type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "filler ".repeat(8) },
      })),
      { type: "message_stop" },
    ]);

    const relayed = await passthroughChunks(splitBytes(completed, 7), {
      label: "anthropic.wire.event",
      contentType: "text/event-stream",
      correlation: { sessionId: "session-a", requestId: "req_complete" },
    });

    expect(Buffer.concat(relayed)).toEqual(Buffer.from(completed));
    // The failure this guards: the rotating main log no longer holds the tool input deltas.
    const mainLines = readLines(mainPath).concat(readLines(`${mainPath}.1`));
    expect(mainLines.some((line) => JSON.stringify(line).includes("input_json_delta"))).toBe(false);

    // A stream that ends inside the block still leaves what arrived.
    await passthroughChunks([sseBytes(toolUseEvents("msg_cut", "toolu_cut", ['{"text":"한']))], {
      label: "anthropic.wire.event",
      contentType: "text/event-stream",
      correlation: { sessionId: "session-b", requestId: "req_cut" },
    });

    const records = readLines(toolInputPath);
    expect(records.map((record) => record.payload)).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        requestId: "req_complete",
        messageId: "msg_complete",
        toolUseId: "toolu_complete",
        name: "write_note",
        complete: true,
        deltas: 3,
        input: parts.join(""),
      }),
      expect.objectContaining({
        sessionId: "session-b",
        requestId: "req_cut",
        messageId: "msg_cut",
        toolUseId: "toolu_cut",
        complete: false,
        input: '{"text":"한',
      }),
    ]);
    // Every main log entry of the cut stream carries the same stream id as its tool input record.
    const cutStream = (records[1]?.payload as { stream?: unknown }).stream;
    expect(typeof cutStream).toBe("string");
    const cutEntries = readLines(`${mainPath}.1`).concat(readLines(mainPath))
      .filter((line) => /msg_cut|toolu_cut/.test(JSON.stringify(line)));
    expect(cutEntries).toHaveLength(2);
    expect(cutEntries.every((line) => (line.payload as { stream?: unknown }).stream === cutStream)).toBe(true);
  });
});
