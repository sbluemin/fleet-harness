import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_TOOL_PROVIDER_IDENTIFIER,
  ContextWindowExceededError,
  CursorAdapter,
  buildCursorRunPlan,
  decodeConnectFrames,
  encodeConnectFrame,
  resetCursorWireModelMemory,
  setWireLogTarget,
} from "../../../../src/index.js";
import type {
  CanonicalFunctionTool,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CursorAdapterOptions,
  CursorDiagnosticEvent,
  ReasoningEffort,
} from "../../../../src/index.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
} from "../../../../src/upstream/cursor/native/generated/cursor-agent-protobuf.js";

const temporaryWireLogDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  resetCursorWireModelMemory();
  setWireLogTarget(undefined);
  for (const directory of temporaryWireLogDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function wireLogFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-cursor-wire-log-"));
  temporaryWireLogDirectories.push(directory);
  const filePath = path.join(directory, "wire-log.jsonl");
  setWireLogTarget({ path: filePath });
  return filePath;
}

function cursorWireEntries(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cursorWirePlanCount(filePath: string): number {
  return cursorWireEntries(filePath).filter((entry) => entry.event === "cursor.wire.plan").length;
}

describe("Cursor live client-tool Run bridge", () => {

  it("fails closed on the same Run when the caller Bash Grep receipt is incomplete", async () => {
    const nativeCall = cursorCall("native-grep-shell-failure", 29);
    const stream = new BridgeCursorStream(
      [{
        execServerMessage: {
          id: nativeCall.messageId,
          execId: nativeCall.execId,
          grepArgs: {
            pattern: "Fleet",
            path: "packages",
            toolCallId: nativeCall.callId,
          },
        },
      }],
      cursorCompletionFrames("grep failure handled"),
      1,
    );
    const harness = cursorHarness([stream]);
    const initial: CanonicalResponseRequest = {
      ...cursorRequest("session-native-grep-shell-failure", "composer-2.5"),
      tools: [{
        type: "function",
        name: "Bash",
        description: "Run a shell command under caller permissions",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }],
    };

    try {
      const initialEvents = await collectCursorResponse(harness.adapter, initial);
      const callId = addedFunctionCallIds(initialEvents)[0];
      if (!callId) throw new Error("Missing redirected Bash call");
      const events = await collectCursorResponse(
        harness.adapter,
        cursorContinuation(
          initial,
          [{ ...nativeCall, name: "Bash" }],
          [{ call_id: callId, output: "truncated caller output" }],
        ),
      );

      expect(canonicalText(events)).toBe("grep failure handled");
      expect(harness.openedStreams).toBe(1);
      expect(cursorClientWrites(stream)).toContainEqual(expect.objectContaining({
        execClientMessage: expect.objectContaining({
          grepResult: {
            error: { error: expect.stringContaining("complete Fleet Grep receipt") },
          },
        }),
      }));
    } finally {
      harness.adapter.dispose();
    }
  });

  it("parks a call whose exec message is the first of the Run", async () => {
    // Cursor numbers exec messages from zero and `id` has implicit presence, so the first client
    // tool of a Run arrives with no `id` field at all. Every other call here carries a nonzero id.
    const call = cursorCall("call-first-exec-of-run", 0);
    const stream = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("first exec completed"),
      1,
    );
    const diagnostics: CursorDiagnosticEvent[] = [];
    const harness = cursorHarness([stream], {
      diagnostics: (event) => diagnostics.push(event),
    });
    const initial = cursorRequest("session-first-exec", "grok-4.5");

    try {
      await collectCursorResponseWithDiagnostics(harness.adapter, initial, true);
      const secondEvents = await collectCursorResponseWithDiagnostics(
        harness.adapter,
        cursorContinuation(initial, [call], [cursorResult(call, "README contents")]),
        true,
      );

      expect(canonicalText(secondEvents)).toBe("first exec completed");
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "bridge.park",
        outcome: "client_tool_suspended",
      }));
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "bridge.attach",
        outcome: "exact_match",
      }));
      expect(diagnostics).not.toContainEqual(expect.objectContaining({ event: "bridge.mismatch" }));
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("keeps credential A parked while credential B cold-resumes the same conversation", async () => {
    const credentialA = "cursor-credential-a";
    const credentialB = "cursor-credential-b";
    const call = cursorCall("call-credential-partition", 56);
    const credentialARun = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("credential A attached"),
      1,
    );
    const credentialBRun = new BridgeCursorStream(
      cursorCompletionFrames("credential B cold fallback"),
    );
    const harness = cursorHarness([credentialARun, credentialBRun]);
    const initial = cursorRequest("shared-credential-conversation", "grok-4.5");
    const continuation = cursorContinuation(initial, [call], [cursorResult(call, "done")]);

    try {
      await collectCursorResponse(harness.adapter, initial, credentialA);
      const credentialBEvents = await collectCursorResponse(
        harness.adapter,
        continuation,
        credentialB,
      );

      expect(canonicalText(credentialBEvents)).toBe("credential B cold fallback");
      expect(credentialARun.closed).toBe(false);
      expect(cursorMcpResultWrites(credentialARun)).toHaveLength(0);
      expect(cursorMcpResultWrites(credentialBRun)).toHaveLength(0);
      expect(cursorClientWrites(credentialBRun)[0]).toMatchObject({
        runRequest: { action: { resumeAction: {} } },
      });

      const credentialAEvents = await collectCursorResponse(
        harness.adapter,
        continuation,
        credentialA,
      );
      expect(canonicalText(credentialAEvents)).toBe("credential A attached");
      expect(cursorMcpResultWrites(credentialARun)).toHaveLength(1);
      expect(cursorMcpResultWrites(credentialBRun)).toHaveLength(0);
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("atomically claims a pending Run so concurrent attaches cannot double-write", async () => {
    const call = cursorCall("call-atomic", 71);
    const parked = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("attached once"),
      1,
    );
    const fallback = new BridgeCursorStream(cursorCompletionFrames("duplicate fallback"));
    const harness = cursorHarness([parked, fallback]);
    const initial = cursorRequest("session-atomic", "composer-2.5-fast");
    const continuation = cursorContinuation(initial, [call], [cursorResult(call, "once")]);

    try {
      await collectCursorResponse(harness.adapter, initial);
      const responses = await Promise.all([
        harness.adapter.stream(continuation, { apiKey: "cursor-test-token" }),
        harness.adapter.stream(continuation, { apiKey: "cursor-test-token" }),
      ]);
      await Promise.all(responses.map(collectAdapterEvents));

      expect(cursorMcpResultWrites(parked)).toHaveLength(1);
      expect(harness.openedStreams).toBe(2);
      expect(cursorClientWrites(fallback)[0]).toMatchObject({
        runRequest: { action: { resumeAction: {} } },
      });
    } finally {
      harness.adapter.dispose();
    }
  });

  it("cancels an attached Run when the client aborts before suspension", async () => {
    const stream = new BridgeCursorStream([]);
    const harness = cursorHarness([stream]);
    const controller = new AbortController();
    const response = await harness.adapter.stream(
      cursorRequest("session-abort-before", "grok-4.5"),
      { apiKey: "cursor-test-token", signal: controller.signal },
    );
    const collecting = collectAdapterEvents(response);
    controller.abort();

    await expect(collecting).rejects.toThrow("cancelled by caller");
    expect(stream.closed).toBe(true);
    expect(harness.sessions[0]?.closeCount).toBeGreaterThan(0);
    harness.adapter.dispose();
  });
});

async function expectCorrelationBatchColdFallback(
  frames: readonly unknown[],
  calls: readonly CursorCallSpec[],
  userId: string,
): Promise<void> {
  const rejected = new BridgeCursorStream(frames);
  const fallback = new BridgeCursorStream(cursorCompletionFrames("correlation cold fallback"));
  const harness = cursorHarness([rejected, fallback]);
  const initial = cursorRequest(userId, "grok-4.5");

  try {
    await collectCursorResponse(harness.adapter, initial);
    const events = await collectCursorResponse(
      harness.adapter,
      cursorContinuation(
        initial,
        calls,
        calls.map((call) => cursorResult(call, `${call.callId} result`)),
      ),
    );

    expect(canonicalText(events)).toBe("correlation cold fallback");
    expect(cursorMcpResultWrites(rejected)).toHaveLength(0);
    expect(rejected.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(cursorClientWrites(fallback)[0]).toMatchObject({
      runRequest: { action: { resumeAction: {} } },
    });
    expect(harness.openedStreams).toBe(2);
  } finally {
    harness.adapter.dispose();
  }
}

interface CursorCallSpec {
  readonly callId: string;
  readonly toolCallId: string;
  readonly messageId: number;
  readonly execId: string;
  readonly name: string;
}

function cursorCall(callId: string, messageId: number): CursorCallSpec {
  return {
    callId,
    toolCallId: `cursor-${callId}`,
    messageId,
    execId: `exec-${messageId}`,
    name: "probe_tool",
  };
}

function cursorGrepReceipt(value: unknown): string {
  return `FLEET_CURSOR_GREP_V2:${deflateRawSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64url")}`;
}

function cursorResult(
  call: CursorCallSpec,
  output: string,
  isError = false,
): Extract<CanonicalResponseRequest["input"][number], { type: "function_call_output" }> {
  return {
    type: "function_call_output",
    call_id: call.callId,
    output,
    ...(isError ? { is_error: true } : {}),
  };
}

const PROBE_TOOLS: readonly CanonicalFunctionTool[] = [{
  type: "function",
  name: "probe_tool",
  description: "Read a named path",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
}];

function cursorRequest(
  userId: string,
  model: string,
  effort?: ReasoningEffort,
): CanonicalResponseRequest {
  return {
    model,
    instructions: "Use probe_tool and continue until complete.",
    input: [{ type: "message", role: "user", content: "Read README.md." }],
    tools: PROBE_TOOLS.map((tool) => ({ ...tool })),
    metadata: { user_id: userId },
    ...(effort === undefined ? {} : { reasoning: { summary: "auto", effort } }),
    stream: true,
  };
}

function cursorContinuation(
  initial: CanonicalResponseRequest,
  calls: readonly CursorCallSpec[],
  results: readonly { readonly call_id: string; readonly output: string; readonly is_error?: boolean }[],
): CanonicalResponseRequest {
  return {
    ...initial,
    input: [
      initial.input[0]!,
      ...calls.map((call) => ({
        type: "function_call" as const,
        call_id: call.callId,
        name: call.name,
        arguments: JSON.stringify({ path: "README.md" }),
      })),
      ...results.map((result) => ({
        type: "function_call_output" as const,
        call_id: result.call_id,
        output: result.output,
        ...(result.is_error === undefined ? {} : { is_error: result.is_error }),
      })),
    ],
  };
}

function cursorToolFrames(calls: readonly CursorCallSpec[]): unknown[] {
  return calls.flatMap((call) => [
    cursorToolStartedFrame(call),
    cursorExecFrame(call),
  ]);
}

function cursorToolStartedFrame(call: CursorCallSpec): unknown {
  return cursorToolUpdateFrame("toolCallStarted", call);
}

function cursorToolPartialFrame(call: CursorCallSpec): unknown {
  return cursorToolUpdateFrame("partialToolCall", call, { argsTextDelta: "{}" });
}

function cursorToolCompletedFrame(call: CursorCallSpec): unknown {
  return cursorToolUpdateFrame("toolCallCompleted", call);
}

function cursorToolUpdateFrame(
  update: "toolCallStarted" | "partialToolCall" | "toolCallCompleted",
  call: CursorCallSpec,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    interactionUpdate: {
      [update]: {
        callId: call.callId,
        toolCall: {
          mcpToolCall: {
            args: {
              name: call.name,
              toolName: call.name,
              toolCallId: call.toolCallId,
              providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
            },
          },
        },
        ...extra,
      },
    },
  };
}

function cursorExecFrame(call: CursorCallSpec): unknown {
  return {
    execServerMessage: {
      id: call.messageId,
      execId: call.execId,
      mcpArgs: {
        name: call.name,
        toolName: call.name,
        toolCallId: call.toolCallId,
        providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
        args: { path: cursorValue("README.md") },
      },
    },
  };
}

function cursorCompletionFrames(text: string): unknown[] {
  return [
    { interactionUpdate: { textDelta: { text } } },
    { interactionUpdate: { tokenDelta: { tokens: 4 } } },
    { interactionUpdate: { turnEnded: {} } },
  ];
}

async function collectCursorResponse(
  adapter: CursorAdapter,
  request: CanonicalResponseRequest,
  apiKey = "cursor-test-token",
  signal?: AbortSignal,
): Promise<readonly CanonicalResponseEvent[]> {
  return collectAdapterEvents(await adapter.stream(request, { apiKey, signal }));
}

async function collectCursorResponseWithDiagnostics(
  adapter: CursorAdapter,
  request: CanonicalResponseRequest,
  diagnosticsEnabled: boolean,
): Promise<readonly CanonicalResponseEvent[]> {
  return collectAdapterEvents(await adapter.stream(request, {
    apiKey: "cursor-test-token",
    diagnosticsEnabled,
  }));
}

async function collectAdapterEvents(
  response: Awaited<ReturnType<CursorAdapter["stream"]>>,
): Promise<readonly CanonicalResponseEvent[]> {
  if (!response.ok) throw new Error("Synthetic Cursor response unexpectedly failed");
  const events: CanonicalResponseEvent[] = [];
  for await (const event of response.events) events.push(event);
  return events;
}

function addedFunctionCallIds(events: readonly CanonicalResponseEvent[]): readonly string[] {
  return events.flatMap((event) => (
    event.type === "response.output_item.added" && event.item.type === "function_call"
      ? [event.item.call_id]
      : []
  ));
}

function canonicalText(events: readonly CanonicalResponseEvent[]): string {
  return events
    .filter((event): event is Extract<CanonicalResponseEvent, { type: "response.output_text.delta" }> => (
      event.type === "response.output_text.delta"
    ))
    .map((event) => event.delta)
    .join("");
}

function cursorCompletedUsage(events: readonly CanonicalResponseEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "response.completed") return event.response.usage;
  }
  throw new Error("Missing Cursor response.completed event");
}

function cursorAdapterLiveState(adapter: CursorAdapter): {
  readonly liveRuns: number;
  readonly pendingRuns: number;
  readonly pendingTimers: number;
} {
  const state = adapter as unknown as {
    readonly liveRuns: ReadonlySet<unknown>;
    readonly pendingLiveRuns: ReadonlyMap<unknown, { readonly timer: unknown }>;
  };
  return {
    liveRuns: state.liveRuns.size,
    pendingRuns: state.pendingLiveRuns.size,
    pendingTimers: new Set([...state.pendingLiveRuns.values()].map((pending) => pending.timer)).size,
  };
}

interface CursorHarness {
  readonly adapter: CursorAdapter;
  readonly sessions: FakeCursorSession[];
  readonly openedStreams: number;
}

function cursorHarness(
  streams: readonly BridgeCursorStream[],
  options: Partial<CursorAdapterOptions> = {},
): CursorHarness {
  const sessions: FakeCursorSession[] = [];
  let openedStreams = 0;
  const connect = (() => {
    const stream = streams[openedStreams];
    if (!stream) throw new Error(`Unexpected Cursor Run ${openedStreams + 1}`);
    openedStreams += 1;
    const session = new FakeCursorSession(stream);
    sessions.push(session);
    return session as unknown as http2.ClientHttp2Session;
  }) as typeof http2.connect;
  const adapter = new CursorAdapter({
    connect,
    idleTimeoutMs: 60_000,
    clientHeartbeatMs: 60_000,
    toolFinalizeGraceMs: 0,
    ...options,
  });
  return {
    adapter,
    sessions,
    get openedStreams() {
      return openedStreams;
    },
  };
}

class FakeCursorSession extends EventEmitter {
  closeCount = 0;

  constructor(private readonly stream: BridgeCursorStream) {
    super();
  }

  request(): BridgeCursorStream {
    return this.stream;
  }

  close(): void {
    this.closeCount += 1;
  }
}

function cursorExecResultCompleted(message: Record<string, unknown>): boolean {
  return message.mcpResult !== undefined
    || message.readResult !== undefined
    || message.grepResult !== undefined
    || message.shellResult !== undefined;
}

interface BridgeCursorRelease {
  readonly afterMcpResults: number;
  readonly frames: readonly unknown[];
}

class BridgeCursorStream extends EventEmitter {
  readonly writes: Buffer[] = [];
  closed = false;
  destroyed = false;
  writableEnded = false;
  closeCode: number | undefined;
  private initialReleased = false;
  private responded = false;
  private mcpResultCount = 0;
  private readonly releasedMcpCounts = new Set<number>();
  private readonly continuationReleases: readonly BridgeCursorRelease[];

  constructor(
    private readonly initialFrames: readonly unknown[],
    continuationFrames: readonly unknown[] = [],
    expectedMcpResults?: number,
    additionalReleases: readonly BridgeCursorRelease[] = [],
  ) {
    super();
    this.continuationReleases = [
      ...(expectedMcpResults === undefined
        ? []
        : [{ afterMcpResults: expectedMcpResults, frames: continuationFrames }]),
      ...additionalReleases,
    ];
  }

  setTimeout(): this {
    return this;
  }

  write(chunk: Uint8Array): boolean {
    const value = Buffer.from(chunk);
    this.writes.push(value);
    this.respond();
    const message = decodeCursorClientFrame(value);
    if (!this.initialReleased && isRecord(message) && message.runRequest !== undefined) {
      this.initialReleased = true;
      this.release(this.initialFrames);
    }
    if (
      isRecord(message)
      && isRecord(message.execClientMessage)
      && cursorExecResultCompleted(message.execClientMessage)
    ) {
      this.mcpResultCount += 1;
      for (const release of this.continuationReleases) {
        if (
          release.afterMcpResults === this.mcpResultCount
          && !this.releasedMcpCounts.has(release.afterMcpResults)
        ) {
          this.releasedMcpCounts.add(release.afterMcpResults);
          this.release(release.frames);
        }
      }
    }
    return true;
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closeCode = code;
    this.closed = true;
    this.writableEnded = true;
    queueMicrotask(() => this.emit("close"));
  }

  destroy(error?: Error): void {
    if (this.closed) return;
    this.destroyed = true;
    this.closed = true;
    this.writableEnded = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }

  /** Cursor answers with response headers before any frame; the adapter gates decoding on them. */
  private respond(): void {
    if (this.responded) return;
    this.responded = true;
    queueMicrotask(() => this.emit("response", {
      ":status": 200,
      "content-type": "application/connect+proto",
    }));
  }

  /**
   * Deliver frames at an arbitrary point, which is the only way to place Cursor's trailing tail
   * after a park: the park itself is driven by the adapter's own finalize timer, so no
   * write-triggered release can land on the far side of it.
   */
  async emitFrames(frames: readonly unknown[]): Promise<void> {
    this.release(frames);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private release(frames: readonly unknown[]): void {
    if (frames.length === 0) return;
    // A macrotask, so the adapter's response-head continuation has installed its data
    // listener first — an EventEmitter drops what it emits with no listener attached.
    setImmediate(() => {
      if (this.closed) return;
      this.emit("data", Buffer.concat(frames.map(encodeCursorServerFrame)));
    });
  }
}

function cursorClientWrites(stream: BridgeCursorStream): Record<string, unknown>[] {
  return stream.writes.map((write) => decodeCursorClientFrame(write));
}

function cursorMcpResultWrites(stream: BridgeCursorStream): Record<string, unknown>[] {
  return cursorClientWrites(stream).flatMap((message) => {
    const exec = isRecord(message.execClientMessage) ? message.execClientMessage : undefined;
    return exec && exec.mcpResult !== undefined ? [exec] : [];
  });
}

function decodeCursorClientFrame(value: Buffer): Record<string, unknown> {
  const frame = decodeConnectFrames(value).frames[0];
  if (!frame) throw new Error("Missing Cursor client frame");
  const decoded = toJson(
    AgentClientMessageSchema,
    fromBinary(AgentClientMessageSchema, frame.payload),
  );
  if (!isRecord(decoded)) throw new Error("Cursor client frame was not an object");
  return decoded;
}

function encodeCursorServerFrame(value: unknown): Buffer {
  const message = fromJson(AgentServerMessageSchema, value as JsonValue);
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

function cursorValue(value: JsonValue): string {
  return Buffer.from(toBinary(ValueSchema, fromJson(ValueSchema, value))).toString("base64");
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cursor test state");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
