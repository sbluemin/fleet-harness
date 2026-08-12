import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TranscriptReaderTail, toReaderBlocks, type ReaderBlock } from "../server/agent-api/transcript-reader.js";
import { READER_ERROR_CODES, registerTranscriptReaderRoutes } from "../server/agent-api/transcript-reader-routes.js";

function collect(record: Record<string, unknown>): ReaderBlock[] {
  let seq = 0;
  return toReaderBlocks(record, () => ++seq);
}

function assistant(content: unknown): Record<string, unknown> {
  return { type: "assistant", timestamp: "2026-08-13T00:00:00.000Z", message: { content } };
}

async function transcriptFile(lines: readonly unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reader-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

describe("transcript reader projection", () => {
  it("keeps a completed text block whole", () => {
    const blocks = collect(assistant([{ type: "text", text: "**Done.**\n\nNext step follows." }]));

    expect(blocks).toEqual([{
      seq: 1,
      role: "assistant",
      kind: "text",
      at: "2026-08-13T00:00:00.000Z",
      text: "**Done.**\n\nNext step follows.",
    }]);
  });

  it("reports that a thought happened without carrying its content", () => {
    const blocks = collect(assistant([{ type: "thinking", thinking: "internal reasoning that stays server-side" }]));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "thinking", role: "assistant" });
    expect(JSON.stringify(blocks)).not.toContain("internal reasoning");
  });

  it("reduces a tool result to its size and never its body", () => {
    const body = "x".repeat(7906);
    const blocks = collect({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: body }] }] } });

    expect(blocks).toEqual([{ seq: 1, role: "user", kind: "tool_result", chars: 7906 }]);
    expect(JSON.stringify(blocks)).not.toContain("xxxx");
  });

  it("carries a tool name with a single-line argument preview", () => {
    const blocks = collect(assistant([{ type: "tool_use", name: "Bash", input: { command: "ls\n  ~/.claude/projects", timeout: 1000 } }]));

    expect(blocks[0]).toMatchObject({ kind: "tool", tool: "Bash" });
    expect(blocks[0]?.detail).not.toContain("\n");
  });

  it("redacts absolute paths and secrets before a block can reach the browser", () => {
    const blocks = collect(assistant([{
      type: "text",
      text: "Read /Users/someone/secrets/notes.md with Authorization: Bearer abcdefghijkl",
    }]));

    const text = blocks[0]?.text ?? "";
    expect(text).not.toContain("/Users/someone/secrets/notes.md");
    expect(text).not.toContain("abcdefghijkl");
  });

  it("ignores records that are neither a user nor an assistant turn", () => {
    expect(collect({ type: "file-history-snapshot", message: { content: [{ type: "text", text: "noise" }] } })).toEqual([]);
    expect(collect({ type: "ai-title", title: "noise" })).toEqual([]);
  });
});

describe("transcript reader tail", () => {
  it("returns only what was appended since the previous pass", async () => {
    const file = await transcriptFile([assistant([{ type: "text", text: "first" }])]);
    const tail = new TranscriptReaderTail(file);

    const initial = await tail.refresh();
    expect(initial.map((block) => block.text)).toEqual(["first"]);

    await appendFile(file, JSON.stringify(assistant([{ type: "text", text: "second" }])) + "\n");
    const appended = await tail.refresh();

    expect(appended.map((block) => block.text)).toEqual(["second"]);
    expect(tail.snapshot().blocks.map((block) => block.text)).toEqual(["first", "second"]);
  });

  it("withholds a half-written line until its newline arrives", async () => {
    const file = await transcriptFile([assistant([{ type: "text", text: "complete" }])]);
    const tail = new TranscriptReaderTail(file);
    await tail.refresh();

    const partial = JSON.stringify(assistant([{ type: "text", text: "torn" }]));
    await appendFile(file, partial.slice(0, 20));
    expect(await tail.refresh()).toEqual([]);

    await appendFile(file, partial.slice(20) + "\n");
    expect((await tail.refresh()).map((block) => block.text)).toEqual(["torn"]);
  });

  it("starts a new generation when the file is replaced rather than appended", async () => {
    const file = await transcriptFile([assistant([{ type: "text", text: "old session" }])]);
    const tail = new TranscriptReaderTail(file);
    await tail.refresh();
    const before = tail.snapshot().generation;

    await writeFile(file, JSON.stringify(assistant([{ type: "text", text: "new session" }])) + "\n");
    await tail.refresh();
    const after = tail.snapshot();

    expect(after.generation).toBe(before + 1);
    expect(after.blocks.map((block) => block.text)).toEqual(["new session"]);
  });

  it("marks the snapshot truncated once the block budget evicts earlier turns", async () => {
    const lines = Array.from({ length: 6 }, (_, index) => assistant([{ type: "text", text: `turn ${index}` }]));
    const file = await transcriptFile(lines);
    const tail = new TranscriptReaderTail(file, { maxBlocks: 3 });
    await tail.refresh();

    const snapshot = tail.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.blocks.map((block) => block.text)).toEqual(["turn 3", "turn 4", "turn 5"]);
  });
});

describe("transcript reader route gate", () => {
  it("refuses to open while the experimental opt-in is absent", async () => {
    const harness = createReaderHarness({ transcriptReaderEnabled: undefined });

    await harness.get("/api/v1/plugins/terminal/reader/op/stream");

    expect(harness.responses).toEqual([{
      status: 403,
      body: { error: { code: READER_ERROR_CODES.disabled, message: "Transcript reader is disabled." } },
    }]);
  });

  it("refuses to open when the stored settings cannot be read", async () => {
    const harness = createReaderHarness({ throwOnLoad: true });

    await harness.get("/api/v1/plugins/terminal/reader/op/stream");

    expect(harness.responses[0]?.status).toBe(403);
  });

  it("reports a missing transcript rather than opening an empty stream", async () => {
    const harness = createReaderHarness({ transcriptReaderEnabled: true });

    await harness.get("/api/v1/plugins/terminal/reader/op/stream");

    expect(harness.responses).toEqual([{
      status: 409,
      body: {
        error: {
          code: READER_ERROR_CODES.transcriptMissing,
          message: "No transcript yet — send a message in this session first.",
        },
      },
    }]);
  });
});

function createReaderHarness(options: { readonly transcriptReaderEnabled?: boolean; readonly throwOnLoad?: boolean }) {
  let handler: ((context: { req: unknown; res: unknown; pathname: string }) => Promise<boolean>) | undefined;
  const responses: Array<{ status: number; body: unknown }> = [];
  const operation = {
    id: "op",
    pluginId: "terminal",
    type: "agent",
    theaterId: "theater",
    payload: {} as Record<string, unknown>,
    ts: { createdAt: 0, updatedAt: 0 },
  };
  const ctx = {
    pluginId: "terminal",
    basePath: "/api/v1/plugins/terminal",
    registerRouter: (_path: string, registered: typeof handler) => { handler = registered; },
    host: {
      security: { validateHost: () => true, isTerminalAuthorized: () => true },
      http: { writeJson: (_res: unknown, status: number, body: unknown) => responses.push({ status, body }) },
      operations: { get: (id: string) => (id === "op" ? operation : null) },
      events: { subscribe: () => () => undefined },
      lifecycle: { registerCleanup: () => () => undefined },
    },
  };
  registerTranscriptReaderRoutes(ctx as never, {
    globalOptionsService: {
      load: () => {
        if (options.throwOnLoad) throw new Error("unreadable settings");
        return { version: 1, transcriptReaderEnabled: options.transcriptReaderEnabled };
      },
    } as never,
  });
  return {
    responses,
    async get(pathname: string): Promise<void> {
      const req = Object.assign(new EventEmitter(), { method: "GET", headers: {} as Record<string, string> });
      const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
      await handler?.({ req, res, pathname });
    },
  };
}
