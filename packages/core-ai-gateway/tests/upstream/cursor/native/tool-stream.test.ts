import { EventEmitter } from "node:events";
import http2 from "node:http2";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { afterEach, describe, expect, it } from "vitest";

import {
  CURSOR_TOOL_PROVIDER_IDENTIFIER,
  CursorAdapter,
  CursorSessionIdentityError,
  buildCursorRunPlan,
  decodeConnectFrames,
  encodeConnectFrame,
  resetCursorWireModelMemory,
  resolveCursorSessionIdentity,
} from "../../../../src/index.js";
import type {
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CursorDiagnosticEvent,
} from "../../../../src/index.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
} from "../../../../src/upstream/cursor/native/generated/cursor-agent-protobuf.js";
import { cursorNativeExecPolicyReplies } from "../../../../src/upstream/cursor/native/exec-responses.js";
import {
  cursorNativeExecRedirect,
  cursorNativeRedirectResultReplies,
  isCursorHotPathToolName,
  isCursorNativeRedirectToolName,
  isCursorWithheldToolName,
} from "../../../../src/upstream/cursor/native/exec-redirect.js";

afterEach(() => resetCursorWireModelMemory());

describe("Cursor client tool suspension", () => {
  it("completes the turn at execServerMessage instead of waiting forever for turnEnded", async () => {
    const first = await runSyntheticToolTurn("claude-session-a");
    const second = await runSyntheticToolTurn("claude-session-a");
    const other = await runSyntheticToolTurn("claude-session-b");

    const added = first.events.find((event) => event.type === "response.output_item.added");
    const done = first.events.find((event) => event.type === "response.output_item.done");

    expect(added).toMatchObject({ item: { name: "probe_tool" } });
    expect(done).toMatchObject({
      item: {
        name: "probe_tool",
        arguments: JSON.stringify({
          value: "cursor-auto",
          encoded: "cursor-bytes",
          structured: { ok: true },
        }),
      },
    });
    expect(first.events.at(-1)?.type).toBe("response.completed");
    const completed = first.events.at(-1);
    if (completed?.type !== "response.completed") {
      throw new Error("Synthetic Cursor tool turn did not complete");
    }
    expect(completed.response.usage?.input_tokens).toBeGreaterThan(0);
    expect(first.stream.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(first.contentType).toBe("application/connect+proto");
    expect(first.requestContextReply).toMatchObject({
      execClientMessage: {
        id: 7,
        execId: "exec-context-7",
        requestContextResult: {
          success: {
            requestContext: {
              tools: [{ name: "probe_tool", toolName: "probe_tool" }],
            },
          },
        },
      },
    });
    expect(first.conversationId).toBe(second.conversationId);
    expect(first.conversationId).not.toBe(other.conversationId);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.sessionId).not.toBe(other.sessionId);
    expect(first.sessionId).toBe(resolveCursorSessionIdentity(request("claude-session-a")).sessionId);
    expect(first.conversationId).toBe(
      resolveCursorSessionIdentity(request("claude-session-a")).conversationId,
    );
  });

  it("rejects Cursor turns that omit metadata.user_id", async () => {
    await expect(runSyntheticCursorTurn([], {
      model: "default",
      instructions: "Call probe_tool.",
      input: [{ type: "message", role: "user", content: "Call the tool now." }],
      stream: true,
    })).rejects.toBeInstanceOf(CursorSessionIdentityError);
  });

  it("rejects future unknown native exec variants instead of leaving the turn open", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const { events, stream } = await runSyntheticCursorTurn([
      rawCursorServerFrame(31, new Uint8Array(), 31, "future-31"),
      { interactionUpdate: { textDelta: { text: "recovered from unsupported exec" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-unknown-exec"), {
      diagnostics: (event) => diagnostics.push(event),
    });

    const replies = stream.writes.slice(1).map(decodeCursorClientFrame);
    expect(replies).toContainEqual({
      execClientControlMessage: {
        throw: {
          id: 31,
          error: expect.stringContaining("unknownField31"),
        },
      },
    });
    expect(replies).toContainEqual({
      execClientControlMessage: { streamClose: { id: 31 } },
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "server.frame",
      frame: "execServerMessage.unknownField31",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "client.reply",
      reply: "exec.control.unknownField31",
      count: 2,
    }));
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("bounds heartbeat-only Cursor stalls with a semantic timeout", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    await expect(runSyntheticCursorTurn([
      { interactionUpdate: { heartbeat: {} } },
    ], request("claude-session-heartbeat-stall"), {
      diagnostics: (event) => diagnostics.push(event),
      idleTimeoutMs: 20,
    })).rejects.toThrow("cursor stream semantic stall timeout");

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "server.frame",
      frame: "interactionUpdate.heartbeat",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "transport.semantic_timeout",
      outcome: "semantic_stall_timeout",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "turn.finish",
      outcome: "semantic_stall_timeout",
      error: "semantic_stall_timeout",
    }));
  });

});

async function runSyntheticToolTurn(userId: string): Promise<{
  readonly events: readonly CanonicalResponseEvent[];
  readonly stream: FakeCursorStream;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly requestContextReply: unknown;
  readonly contentType: unknown;
}> {
  const callId = "call-probe-1";
  const frames = [
    {
      execServerMessage: {
        id: 7,
        execId: "exec-context-7",
        requestContextArgs: {},
      },
    },
    {
      interactionUpdate: {
        toolCallStarted: {
          callId,
          toolCall: {
            mcpToolCall: {
              args: {
                name: "probe_tool",
                toolCallId: callId,
                providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                toolName: "probe_tool",
              },
            },
          },
        },
      },
    },
    {
      execServerMessage: {
        mcpArgs: {
          name: "probe_tool",
          toolCallId: callId,
          providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
          toolName: "probe_tool",
          args: {
            value: Buffer.from("cursor-auto", "utf8").toString("base64"),
            encoded: Buffer.from("cursor-bytes", "utf8").toString("base64"),
            structured: cursorValue({ ok: true }),
          },
        },
      },
    },
    // Some Cursor builds echo completion after the exec suspension frame. That
    // late activity must re-arm, not permanently cancel, the bounded finalizer.
    {
      interactionUpdate: {
        toolCallCompleted: {
          callId,
          toolCall: {
            mcpToolCall: {
              args: {
                name: "probe_tool",
                toolCallId: callId,
                providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                toolName: "probe_tool",
              },
            },
          },
        },
      },
    },
  ];
  const { events, stream, requestHeaders } = await runSyntheticCursorTurn(frames, request(userId));
  const initial = decodeCursorClientFrame(stream.writes[0] ?? Buffer.alloc(0)) as {
    readonly runRequest?: { readonly conversationId?: unknown };
  };
  const conversationId = initial.runRequest?.conversationId;
  if (typeof conversationId !== "string") throw new Error("Synthetic Cursor request had no conversation id");
  const sessionId = requestHeaders?.["x-session-id"];
  if (typeof sessionId !== "string") throw new Error("Synthetic Cursor request had no x-session-id");
  const requestContextReply = decodeCursorClientFrame(stream.writes[1] ?? Buffer.alloc(0));
  return {
    events,
    stream,
    conversationId,
    sessionId,
    requestContextReply,
    contentType: requestHeaders?.["content-type"],
  };
}

async function runSyntheticCursorTurn(
  frames: readonly SyntheticCursorFrame[],
  canonicalRequest: CanonicalResponseRequest,
  options: {
    readonly releaseOnHeartbeat?: boolean;
    readonly clientHeartbeatMs?: number;
    readonly idleTimeoutMs?: number;
    readonly diagnostics?: (event: CursorDiagnosticEvent) => void;
  } = {},
): Promise<{
  readonly events: readonly CanonicalResponseEvent[];
  readonly stream: FakeCursorStream;
  readonly requestHeaders: http2.OutgoingHttpHeaders | undefined;
}> {
  const stream = new FakeCursorStream(frames, options.releaseOnHeartbeat ?? false);
  let requestHeaders: http2.OutgoingHttpHeaders | undefined;
  const session = Object.assign(new EventEmitter(), {
    request: (headers: http2.OutgoingHttpHeaders) => {
      requestHeaders = headers;
      return stream;
    },
    close: () => undefined,
  });
  const adapter = new CursorAdapter({
    connect: (() => session as unknown as http2.ClientHttp2Session) as typeof http2.connect,
    idleTimeoutMs: options.idleTimeoutMs ?? 1_000,
    toolFinalizeGraceMs: 0,
    clientHeartbeatMs: options.clientHeartbeatMs ?? 5_000,
    diagnostics: options.diagnostics,
  });
  const response = await adapter.stream(canonicalRequest, {
    apiKey: "cursor-test-token",
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error("Synthetic Cursor response unexpectedly failed");

  const events: CanonicalResponseEvent[] = [];
  for await (const event of response.events) events.push(event);
  return { events, stream, requestHeaders };
}

function completedCursorUsage(events: readonly CanonicalResponseEvent[]) {
  const completed = events.at(-1);
  if (completed?.type !== "response.completed" || completed.response.usage == null) {
    throw new Error("Synthetic Cursor turn did not complete with usage");
  }
  return completed.response.usage;
}

function request(userId: string): CanonicalResponseRequest {
  return {
    model: "default",
    instructions: "Call probe_tool.",
    input: [{ type: "message", role: "user", content: "Call the tool now." }],
    tools: [{
      type: "function",
      name: "probe_tool",
      description: "Harmless diagnostic tool",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
          encoded: { type: "string" },
          structured: { type: "object" },
        },
        required: ["value"],
        additionalProperties: false,
      },
    }],
    metadata: { user_id: userId },
    stream: true,
  };
}

function readRequest(): CanonicalResponseRequest {
  return {
    model: "composer-2.5-fast",
    instructions: "Read a repository file with the Read client tool.",
    input: [{ type: "message", role: "user", content: "Read a file and explain it." }],
    tools: [{
      type: "function",
      name: "Read",
      description: "Read a file from the repository",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
        additionalProperties: false,
      },
    }],
    metadata: { user_id: "claude-session-native-retry" },
    stream: true,
  };
}

function taskUpdateRequest(): CanonicalResponseRequest {
  return {
    model: "grok-4.5-fast",
    instructions: "Update task 1.",
    input: [{ type: "message", role: "user", content: "Mark task 1 in progress." }],
    tools: [{
      type: "function",
      name: "TaskUpdate",
      description: "Update a task",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          attempt: { type: "number" },
        },
        required: ["taskId", "status"],
        additionalProperties: false,
      },
    }],
    metadata: { user_id: "claude-session-task-update" },
    stream: true,
  };
}

function firstCursorWireToolName(request: CanonicalResponseRequest): string {
  const plan = buildCursorRunPlan(request, "conversation-wire-name");
  const runRequest = (plan.payload as {
    readonly runRequest?: {
      readonly mcpTools?: { readonly mcpTools?: ReadonlyArray<{ readonly toolName?: string }> };
    };
  }).runRequest;
  const wireName = runRequest?.mcpTools?.mcpTools?.find((tool) => tool.toolName)?.toolName;
  if (!wireName) throw new Error("Missing Cursor wire tool");
  return wireName;
}

function cursorValue(value: JsonValue): string {
  return Buffer.from(toBinary(ValueSchema, fromJson(ValueSchema, value))).toString("base64");
}

function encodeCursorServerFrame(value: unknown): Buffer {
  const message = fromJson(AgentServerMessageSchema, value as JsonValue);
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

interface RawCursorServerFrame {
  readonly rawPayload: Uint8Array;
}

type SyntheticCursorFrame = unknown | RawCursorServerFrame;

function encodeSyntheticCursorServerFrame(value: SyntheticCursorFrame): Buffer {
  return isRawCursorServerFrame(value)
    ? encodeConnectFrame(value.rawPayload)
    : encodeCursorServerFrame(value);
}

function isRawCursorServerFrame(value: SyntheticCursorFrame): value is RawCursorServerFrame {
  return typeof value === "object"
    && value !== null
    && "rawPayload" in value
    && value.rawPayload instanceof Uint8Array;
}

function rawCursorServerFrame(
  fieldNumber: number,
  value: Uint8Array,
  id: number,
  execId: string,
): RawCursorServerFrame {
  const exec = encodeWireMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(id);
    writer.tag(15, WireType.LengthDelimited).string(execId);
    writer.tag(fieldNumber, WireType.LengthDelimited).bytes(value);
  });
  return {
    rawPayload: encodeWireMessage((writer) => {
      writer.tag(2, WireType.LengthDelimited).bytes(exec);
    }),
  };
}

function executeHookArgs(hookCase: number): Uint8Array {
  const request = encodeWireMessage((writer) => {
    writer.tag(hookCase, WireType.LengthDelimited).bytes(new Uint8Array());
  });
  return encodeWireMessage((writer) => {
    writer.tag(1, WireType.LengthDelimited).bytes(request);
  });
}

function executeHookResponseCase(unknownFieldData: Uint8Array): number | undefined {
  try {
    const result = new BinaryReader(unknownFieldData).bytes();
    const resultReader = new BinaryReader(result);
    const [responseField, responseWireType] = resultReader.tag();
    if (responseField !== 1 || responseWireType !== WireType.LengthDelimited) return undefined;
    const response = resultReader.bytes();
    const responseReader = new BinaryReader(response);
    const [hookCase, hookWireType] = responseReader.tag();
    return hookWireType === WireType.LengthDelimited ? hookCase : undefined;
  } catch {
    return undefined;
  }
}

function encodeWireMessage(write: (writer: BinaryWriter) => void): Uint8Array {
  const writer = new BinaryWriter();
  write(writer);
  return writer.finish();
}

function decodeCursorClientMessage(value: Buffer): {
  readonly execId: string;
  readonly execUnknownFields: readonly { readonly no: number; readonly data: Uint8Array }[];
} {
  const frame = decodeConnectFrames(value).frames[0];
  if (!frame) throw new Error("Missing Cursor client frame");
  const message = fromBinary(AgentClientMessageSchema, frame.payload) as unknown as {
    readonly message?: {
      readonly case?: string;
      readonly value?: {
        readonly execId?: string;
        readonly $unknown?: readonly { readonly no: number; readonly data: Uint8Array }[];
      };
    };
  };
  if (message.message?.case !== "execClientMessage") {
    return { execId: "", execUnknownFields: [] };
  }
  return {
    execId: message.message.value?.execId ?? "",
    execUnknownFields: message.message.value?.$unknown ?? [],
  };
}

function decodeCursorClientFrame(value: Buffer): unknown {
  const frame = decodeConnectFrames(value).frames[0];
  if (!frame) throw new Error("Missing Cursor client frame");
  return toJson(
    AgentClientMessageSchema,
    fromBinary(AgentClientMessageSchema, frame.payload),
  );
}

class FakeCursorStream extends EventEmitter {
  readonly writes: Buffer[] = [];
  closeCode: number | undefined;
  private sent = false;
  private responded = false;

  constructor(
    private readonly frames: readonly SyntheticCursorFrame[],
    private readonly releaseOnHeartbeat: boolean,
  ) {
    super();
  }

  setTimeout(): this {
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    // Cursor answers with response headers before any frame; the adapter gates decoding on them.
    if (!this.responded) {
      this.responded = true;
      queueMicrotask(() => this.emit("response", {
        ":status": 200,
        "content-type": "application/connect+proto",
      }));
    }
    const message = this.releaseOnHeartbeat
      ? decodeCursorClientFrame(Buffer.from(chunk)) as Record<string, unknown>
      : undefined;
    if (!this.sent && (!this.releaseOnHeartbeat || message?.clientHeartbeat !== undefined)) {
      this.sent = true;
      // A macrotask, so the adapter's response-head continuation has installed its data
      // listener first — an EventEmitter drops what it emits with no listener attached.
      setImmediate(() => this.emit(
        "data",
        Buffer.concat(this.frames.map(encodeSyntheticCursorServerFrame)),
      ));
    }
    return true;
  }

  close(code?: number): void {
    this.closeCode = code;
    queueMicrotask(() => this.emit("close"));
  }

  destroy(error?: Error): void {
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }
}
